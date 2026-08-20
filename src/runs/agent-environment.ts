/**
 * Managed agents run with broad local authority, so they must never inherit the
 * orchestrator's own secrets. Only variables the provider CLIs and ordinary
 * build tooling genuinely need are forwarded; everything else — Discord
 * credentials, HIVE_* workspace internals, unrelated project secrets — is
 * dropped. Test scripts use the stricter allowlist in command-probe.ts.
 */
const AGENT_ENV_ALLOWLIST = [
  // Process basics
  "PATH", "HOME", "SHELL", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP",
  "LANG", "LC_ALL", "TERM",
  // Provider CLI configuration and credentials
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_HOME",
  // Standard config/cache locations the CLIs read
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME",
  // Toolchains an agent may legitimately need to build and test
  "DEVELOPER_DIR", "JAVA_HOME", "ANDROID_HOME", "ANDROID_SDK_ROOT",
  // Network egress configuration
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
] as const;

export function sanitizedAgentEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(
    AGENT_ENV_ALLOWLIST.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]),
  );
}
