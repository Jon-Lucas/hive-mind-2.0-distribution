/**
 * Discord message shape for studio notifications.
 *
 * Every notification used to be one dense sentence, so a run produced a column
 * of near-identical grey paragraphs — nothing to anchor on, nothing safe to
 * skip. These helpers give each message the same three parts:
 *
 *   **<icon> <headline>**   bold: what happened, scannable at a glance
 *   <body lines>            the detail actually worth reading
 *   -# <meta>               subtext: telemetry that should recede
 *
 * Substance is unchanged from the prose versions — presentation only.
 */

/** Discord renders a leading `-# ` as small grey subtext. */
const SUBTEXT = "-# ";

/** Separator used between short fields on one line, studio-wide. */
const FIELD_SEPARATOR = " · ";

type Part = string | null | undefined | false;

export interface Notice {
  icon: string;
  headline: string;
  /** Detail lines. Falsy entries drop out, so callers can inline conditionals. */
  body?: Part[];
  /** Low-priority metadata, joined and rendered as subtext. */
  meta?: Part[];
  /**
   * Render the headline as an `##` heading rather than bold. Reserved for the
   * rare events worth interrupting a scroll — a heading used routinely stops
   * reading as emphasis and just becomes the new baseline.
   */
  heading?: boolean;
}

export function renderNotice(notice: Notice): string {
  const title = `${notice.icon} ${notice.headline}`.trim();
  const lines = [notice.heading ? `## ${title}` : `**${title}**`];
  for (const line of notice.body ?? []) if (line) lines.push(line);
  const meta = present(notice.meta);
  if (meta.length > 0) lines.push(`${SUBTEXT}${meta.join(FIELD_SEPARATOR)}`);
  return lines.join("\n");
}

/** Joins the parts that are present, dropping the rest. */
export function fields(...parts: Part[]): string {
  return present(parts).join(FIELD_SEPARATOR);
}

/** Inline code — commits, paths and targets read better set apart from prose. */
export function code(value: string): string {
  return `\`${value}\``;
}

/** Pluralises a count for message bodies: `plural(2, "cycle")` → `"2 cycles"`. */
export function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function present(parts: Part[] | undefined): string[] {
  return (parts ?? []).filter((part): part is string => Boolean(part));
}
