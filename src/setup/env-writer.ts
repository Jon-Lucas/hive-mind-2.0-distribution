import fs from "node:fs";

/**
 * Upserts a single KEY=VALUE line into a .env file, creating the file if it
 * does not exist yet and preserving every other line untouched. This is how
 * a pasted API key becomes durable across restarts without hand-editing the
 * file — the same file `loadEnvFile` reads back on the next boot.
 */
export function upsertEnvValue(envPath: string, key: string, value: string): void {
  const sanitized = value.replace(/[\r\n]/g, "").trim();
  const line = `${key}=${sanitized}`;
  let content: string;
  try {
    content = fs.readFileSync(envPath, "utf8");
  } catch {
    content = "";
  }
  const pattern = new RegExp(`^${key}=.*$`, "m");
  content = pattern.test(content) ? content.replace(pattern, line) : `${content}${content && !content.endsWith("\n") ? "\n" : ""}${line}\n`;
  // Contains a secret; keep it readable only by the owner.
  fs.writeFileSync(envPath, content, { mode: 0o600 });
}
