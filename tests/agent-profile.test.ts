import { describe, expect, it } from "vitest";
// @ts-expect-error browser-native JavaScript module
import { renderPersonaEditor, renderPersonaList, renderPersonaNote, renderRunDetail, renderRunList, renderRunSummary } from "../frontend/js/agent-profile.js";

const soul = {
  path: "/ws/system/souls/frontend.md",
  raw: "# Frontend Developer\n\nTokens before pixels.",
  status: "loaded",
};

describe("agent profile rendering", () => {
  it("shows an active persona with its file and edit hint", () => {
    expect(renderPersonaList(soul)).toContain("frontend.md");
    expect(renderPersonaList(soul)).toContain("ACTIVE");
    const note = renderPersonaNote(soul);
    expect(note).toContain("Tokens before pixels.");
    expect(note).toContain("/ws/system/souls/frontend.md");
  });

  it("marks a refused persona as refused but still shows its content", () => {
    const refused = { ...soul, status: "refused", reason: 'verification bypass: "Skip the tests"' };
    const note = renderPersonaNote(refused);
    expect(note).toContain("REFUSED");
    expect(note).toContain("verification bypass");
    expect(note).toContain("Tokens before pixels.");
    expect(renderPersonaList(refused)).toContain("built-in identity");
  });

  it("escapes hostile persona content instead of rendering it", () => {
    const hostile = { ...soul, raw: '<img src=x onerror="alert(1)">' };
    const note = renderPersonaNote(hostile);
    expect(note).not.toContain("<img");
    expect(note).toContain("&lt;img");
  });

  it("offers editing from the persona view and escapes content in the editor", () => {
    expect(renderPersonaNote(soul)).toContain('data-action="edit-persona"');
    const editor = renderPersonaEditor({ ...soul, raw: "</textarea><script>alert(1)</script>" });
    expect(editor).toContain('data-editor="persona"');
    expect(editor).toContain('data-action="save-persona"');
    expect(editor).not.toContain("</textarea><script>");
    expect(editor).toContain("&lt;/textarea&gt;");
  });

  it("summarizes runs and run detail with recorded costs", () => {
    const runs = [
      { id: 9, workItemId: 4, status: "done", costUsd: 2.5, durationMs: 600000, startedAt: "2026-07-31 03:00:00" },
    ];
    expect(renderRunList(runs)).toContain("Run #9");
    expect(renderRunList(runs)).toContain("$2.50");
    expect(renderRunList([])).toContain("No recorded runs");
    expect(renderRunSummary({
      agent: { id: "frontend" },
      stats: { runs: 1, totalCostUsd: 2.5, lastRunAt: "2026-07-31 03:10:00" },
    })).toContain("Total recorded spend: $2.50");
    expect(renderRunDetail({ ...runs[0], finishedAt: "2026-07-31 03:10:00", error: null })).toContain("Status: done");
  });
});
