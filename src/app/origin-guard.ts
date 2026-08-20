/**
 * The API binds to loopback but the operator's own browser sits inside that
 * boundary, so loopback alone stops nothing. Two checks close the gap:
 *
 * - Host: a DNS-rebinding attacker resolves their own name to 127.0.0.1, so the
 *   request arrives with a foreign Host header. Rejecting unknown hosts breaks
 *   the rebind.
 * - Origin: WebSockets are not covered by the same-origin policy, so any page
 *   can open /ws. Browsers always attach Origin to those handshakes.
 *
 * A missing Origin is allowed: non-browser clients (curl, tests, the ws client)
 * omit it, and browsers omit it on same-origin navigations. Host covers those.
 */

export function allowedHostsFor(host: string, port: number): string[] {
  const names = host === "0.0.0.0" || host === "::" ? ["127.0.0.1", "localhost"] : [host, "localhost"];
  return [...new Set(names)].map((name) => `${name}:${port}`.toLowerCase());
}

export function isAllowedHost(header: string | undefined, allowedHosts: string[]): boolean {
  if (!header) return false;
  return allowedHosts.includes(header.trim().toLowerCase());
}

export function isAllowedOrigin(origin: string | undefined, allowedHosts: string[]): boolean {
  if (origin === undefined) return true;
  if (origin === "null") return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  return allowedHosts.includes(parsed.host.toLowerCase());
}
