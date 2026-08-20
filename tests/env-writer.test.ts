import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { upsertEnvValue } from "../src/setup/env-writer.js";

describe("upsertEnvValue", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("creates the file when it does not exist yet", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-env-"));
    const envPath = path.join(dir, ".env");

    upsertEnvValue(envPath, "ANTHROPIC_API_KEY", "sk-ant-test");

    expect(fs.readFileSync(envPath, "utf8")).toBe("ANTHROPIC_API_KEY=sk-ant-test\n");
  });

  it("appends a new key without disturbing existing lines", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-env-"));
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(envPath, "PORT=4401\nHIVE_WORKSPACE=/tmp/ws\n");

    upsertEnvValue(envPath, "OPENAI_API_KEY", "sk-oai-test");

    const content = fs.readFileSync(envPath, "utf8");
    expect(content).toBe("PORT=4401\nHIVE_WORKSPACE=/tmp/ws\nOPENAI_API_KEY=sk-oai-test\n");
  });

  it("replaces an existing key in place instead of duplicating it", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-env-"));
    const envPath = path.join(dir, ".env");
    fs.writeFileSync(envPath, "PORT=4401\nANTHROPIC_API_KEY=sk-ant-old\nHIVE_WORKSPACE=/tmp/ws\n");

    upsertEnvValue(envPath, "ANTHROPIC_API_KEY", "sk-ant-new");

    const content = fs.readFileSync(envPath, "utf8");
    expect(content).toBe("PORT=4401\nANTHROPIC_API_KEY=sk-ant-new\nHIVE_WORKSPACE=/tmp/ws\n");
    expect(content.match(/ANTHROPIC_API_KEY/g)).toHaveLength(1);
  });

  it("strips stray newlines pasted into the value so the file cannot be corrupted", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-env-"));
    const envPath = path.join(dir, ".env");

    upsertEnvValue(envPath, "ANTHROPIC_API_KEY", "sk-ant-test\nEVIL=1\n");

    expect(fs.readFileSync(envPath, "utf8")).toBe("ANTHROPIC_API_KEY=sk-ant-testEVIL=1\n");
  });

  it("restricts the file to owner-only permissions since it now holds a secret", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "hive-env-"));
    const envPath = path.join(dir, ".env");

    upsertEnvValue(envPath, "ANTHROPIC_API_KEY", "sk-ant-test");

    expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
  });
});
