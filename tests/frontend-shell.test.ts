import fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("focused Hive Mind 2.0 shell", () => {
  it("shows only the three-agent studio and removes legacy Working Memory", () => {
    const html = fs.readFileSync(new URL("../frontend/index.html", import.meta.url), "utf8");

    expect(html).toContain("Brain");
    expect(html).toContain("Developer");
    expect(html).toContain("Tester");
    expect(html).toContain('id="retry-workflow"');
    expect(html).toContain('id="second-brain-status"');
    expect(html).toContain("Atlas");
    expect(html).toContain("Projects");
    expect(html).toContain("zcomplete");
    expect(html).not.toMatch(/WORKING MEMORY/i);
    expect(html).not.toContain("js/board.js");
    expect(html).not.toContain("js/roster.js");
    expect(html).toContain("js/app.js");
  });

  it("keeps the status footer in flow so it cannot cover model controls", () => {
    const css = fs.readFileSync(new URL("../frontend/style.css", import.meta.url), "utf8");
    const footerRule = css.match(/footer\s*\{([^}]*)\}/s)?.[1] ?? "";

    expect(footerRule).toMatch(/position:\s*static/);
    expect(footerRule).not.toMatch(/position:\s*(?:fixed|sticky)/);
  });

  it("lands the conversation on the latest message without a top-to-bottom animation", () => {
    const css = fs.readFileSync(new URL("../frontend/style.css", import.meta.url), "utf8");
    const messagesRule = css.match(/\.messages\s*\{([^}]*)\}/s)?.[1] ?? "";

    expect(messagesRule).toMatch(/scroll-behavior:\s*auto/);
    expect(messagesRule).not.toMatch(/scroll-behavior:\s*smooth/);
  });
});
