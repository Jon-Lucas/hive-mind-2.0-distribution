import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app/build-app.js";
import { BrainService } from "../src/conversation/brain-service.js";
import { createDatabase, type HiveDatabase } from "../src/storage/database.js";
import { WorkflowService } from "../src/workflow/workflow-service.js";
import type { AgentGateway, AgentRequest, AgentResponse } from "../src/agents/agent-gateway.js";

class RecordingGateway implements AgentGateway {
  requests: AgentRequest[] = [];

  async run(request: AgentRequest): Promise<AgentResponse> {
    this.requests.push(request);
    return { text: JSON.stringify({ kind: "message", text: "Reference received." }) };
  }
}

// A real 1x1 transparent PNG, so the served bytes are a decodable image.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("reference image attachments", () => {
  let database: HiveDatabase | undefined;
  let attachmentsRoot: string | undefined;
  afterEach(() => {
    database?.close();
    if (attachmentsRoot) fs.rmSync(attachmentsRoot, { recursive: true, force: true });
  });

  const build = async () => {
    database = createDatabase(":memory:");
    attachmentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hive-attachments-"));
    const gateway = new RecordingGateway();
    const app = await buildApp({
      database,
      frontendRoot: new URL("../frontend", import.meta.url).pathname,
      gateway,
      attachmentsRoot,
    });
    return { app, gateway };
  };

  it("uploads an image, serves it back, and hands Brain a readable path", async () => {
    const { app, gateway } = await build();

    const uploaded = await app.inject({
      method: "POST",
      url: "/api/brain/attachments",
      payload: { name: "ring reference.png", mime: "image/png", data: PNG_BASE64 },
    });
    expect(uploaded.statusCode).toBe(200);
    const attachment = uploaded.json() as { file: string; url: string };
    expect(attachment.file).toMatch(/\.png$/);
    expect(fs.existsSync(path.join(attachmentsRoot!, attachment.file))).toBe(true);

    const served = await app.inject({ method: "GET", url: attachment.url });
    expect(served.statusCode).toBe(200);
    expect(served.headers["content-type"]).toContain("image/png");
    expect(served.rawPayload.equals(Buffer.from(PNG_BASE64, "base64"))).toBe(true);

    const sent = await app.inject({
      method: "POST",
      url: "/api/brain/messages",
      payload: {
        text: "Match this ring.",
        attachments: [{ file: attachment.file, name: "ring reference.png", mime: "image/png" }],
      },
    });
    expect(sent.statusCode).toBe(200);

    const prompt = gateway.requests[0]?.prompt ?? "";
    expect(prompt).toContain("Match this ring.");
    expect(prompt).toContain(path.join(attachmentsRoot!, attachment.file));
    expect(prompt).toContain("Read tool");

    // The GUI reads attachments back from both message endpoints.
    const messages = await app.inject({ method: "GET", url: "/api/brain/messages" });
    expect(messages.json()[0].attachments).toEqual([
      { file: attachment.file, name: "ring reference.png", mime: "image/png" },
    ]);
    const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap" });
    const bootstrapMessages = bootstrap.json().messages as Array<{ attachments: unknown[] }>;
    expect(bootstrapMessages[0]?.attachments).toHaveLength(1);
    await app.close();
  });

  it("accepts an image-only message and keeps the paths in later replayed turns", async () => {
    const { app, gateway } = await build();
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/brain/attachments",
      payload: { name: "arc.png", mime: "image/png", data: PNG_BASE64 },
    });
    const attachment = uploaded.json() as { file: string };

    const imageOnly = await app.inject({
      method: "POST",
      url: "/api/brain/messages",
      payload: { text: "", attachments: [{ file: attachment.file, name: "arc.png", mime: "image/png" }] },
    });
    expect(imageOnly.statusCode).toBe(200);

    await app.inject({ method: "POST", url: "/api/brain/messages", payload: { text: "Same as the image above." } });
    const replayed = gateway.requests[1]?.conversation.map((message) => message.text).join("\n") ?? "";
    expect(replayed).toContain(attachment.file);
    await app.close();
  });

  it("rejects non-image uploads, oversized files, and unknown attachment references", async () => {
    const { app } = await build();

    const badMime = await app.inject({
      method: "POST",
      url: "/api/brain/attachments",
      payload: { name: "notes.pdf", mime: "application/pdf", data: PNG_BASE64 },
    });
    expect(badMime.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/brain/attachments",
      payload: { name: "big.png", mime: "image/png", data: Buffer.alloc(11 * 1024 * 1024).toString("base64") },
    });
    expect(oversized.statusCode).toBe(400);

    const traversal = await app.inject({
      method: "POST",
      url: "/api/brain/messages",
      payload: { text: "hi", attachments: [{ file: "../../etc/passwd", name: "x", mime: "image/png" }] },
    });
    expect(traversal.statusCode).toBe(400);

    const missing = await app.inject({
      method: "POST",
      url: "/api/brain/messages",
      payload: {
        text: "hi",
        attachments: [{ file: "00000000-0000-4000-8000-000000000000.png", name: "ghost.png", mime: "image/png" }],
      },
    });
    expect(missing.statusCode).toBe(400);
    await app.close();
  });

  it("freezes only server-stored reference images into a Brain plan", async () => {
    database = createDatabase(":memory:");
    attachmentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hive-attachments-plan-"));
    let storedFile = "";
    const planGateway: AgentGateway = {
      run: async () => ({ text: JSON.stringify({
        kind: "plan",
        text: "Plan ready.",
        projectName: "Ebb",
        workItemTitle: "Real progress ring",
        plan: {
          goal: "The ring encodes cycle position",
          assumptions: [],
          acceptanceCriteria: ["Day 5 and day 25 look different at a glance"],
          testTargets: ["android-emulator"],
          referenceImages: [storedFile, "hallucinated.png"],
        },
      }) }),
    };
    const app = await buildApp({
      database,
      frontendRoot: new URL("../frontend", import.meta.url).pathname,
      gateway: planGateway,
      attachmentsRoot,
    });

    const uploaded = await app.inject({
      method: "POST",
      url: "/api/brain/attachments",
      payload: { name: "ring-1.0.png", mime: "image/png", data: PNG_BASE64 },
    });
    storedFile = (uploaded.json() as { file: string }).file;

    const sent = await app.inject({
      method: "POST",
      url: "/api/brain/messages",
      payload: {
        text: "Build the real ring — match this.",
        attachments: [{ file: storedFile, name: "ring-1.0.png", mime: "image/png" }],
      },
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().plan).toBeTruthy();

    const frozen = database.sqlite.prepare("SELECT reference_images_json FROM plan_versions ORDER BY id DESC LIMIT 1")
      .get() as { reference_images_json: string };
    expect(JSON.parse(frozen.reference_images_json)).toEqual([{ file: storedFile, name: "ring-1.0.png" }]);
    const rejected = database.sqlite.prepare("SELECT detail_json FROM events WHERE kind = 'plan_reference_rejected'").all();
    expect(rejected).toHaveLength(1);

    const bootstrap = await app.inject({ method: "GET", url: "/api/bootstrap" });
    expect(bootstrap.json().latestPlan.referenceImages).toEqual([{ file: storedFile, name: "ring-1.0.png" }]);
    await app.close();
  });

  it("keeps text-only messages working when attachments are not configured", async () => {
    database = createDatabase(":memory:");
    const gateway = new RecordingGateway();
    const brain = new BrainService(database, new WorkflowService(database), gateway);
    const result = await brain.send("gui", "plain message");
    expect(result.message).toBe("Reference received.");
    await expect(brain.send("gui", "with file", [{ file: "a.png", name: "a.png", mime: "image/png" }]))
      .rejects.toThrow("attachments are not configured");
  });
});
