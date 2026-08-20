export const MODEL_CATALOG = {
  openai: ["gpt-5.5", "gpt-5.6-sol"],
  claude: ["claude-opus-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"],
} as const;

/**
 * Reasoning effort, per provider — the ceilings genuinely differ. Codex tops
 * out at xhigh; Claude has a further max tier above it. Offering a level a
 * provider cannot honour would fail at run time, so a selection is validated
 * against the chosen provider's own list.
 */
export const EFFORT_CATALOG = {
  openai: ["low", "medium", "high", "xhigh"],
  claude: ["low", "medium", "high", "xhigh", "max"],
} as const;

/** Every level any provider accepts. */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export type Provider = keyof typeof MODEL_CATALOG;
export type Effort = (typeof EFFORT_LEVELS)[number];

export function isSupportedSelection(provider: string, model: string, effort: string): boolean {
  if (!(provider in MODEL_CATALOG)) return false;
  const key = provider as Provider;
  return (MODEL_CATALOG[key] as readonly string[]).includes(model)
    && (EFFORT_CATALOG[key] as readonly string[]).includes(effort);
}
