import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp } from "../src/app/build-app.js";
import { RealtimeHub } from "../src/realtime/realtime-hub.js";
import { createDatabase, type HiveDatabase } from "../src/storage/database.js";

describe("WebSocket API", () => {
  let database: HiveDatabase | undefined;
  afterEach(() => database?.close());

  it("connects and receives realtime workflow events", async () => {
    database = createDatabase(":memory:");
    const realtime = new RealtimeHub();
    const app = await buildApp({
      database,
      realtime,
      frontendRoot: new URL("../frontend", import.meta.url).pathname,
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("missing test address");

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
    const messages: Array<{ type: string; payload: unknown }> = [];
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });

    realtime.publish("workflow.changed", { workItemId: 42 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "connected" }),
      expect.objectContaining({ type: "workflow.changed", payload: { workItemId: 42 } }),
    ]));
    socket.close();
    await app.close();
  });
});
