export interface ConversationMessage {
  role: "user" | "assistant";
  text: string;
}

export interface AgentRequest {
  role: "brain" | "developer" | "frontend" | "tester";
  provider: string;
  model: string;
  effort: string;
  prompt: string;
  systemPrompt: string;
  conversation: ConversationMessage[];
  cwd?: string;
  evidenceDir?: string;
  artifactDir?: string;
  /**
   * Extra directories a restricted role may read (e.g. uploaded reference
   * images). Default-permission Claude blocks Read outside its working
   * directory, and a headless run has no one to approve the prompt.
   */
  allowedDirectories?: string[];
  /** Persisted agent_runs row, when this request is part of a tracked run. */
  runId?: number;
}

export interface AgentOutputChunk {
  role: AgentRequest["role"];
  runId?: number;
  stream: "stdout" | "stderr";
  text: string;
}

export interface AgentUsage {
  costUSD?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface AgentResponse {
  text: string;
  usage?: AgentUsage;
}

export interface AgentPreflightRequest {
  role: AgentRequest["role"];
  provider: string;
  model: string;
}

export interface AgentProviderReadiness extends AgentPreflightRequest {
  available: boolean;
  detail: string;
}

export interface AgentGateway {
  run(request: AgentRequest): Promise<AgentResponse>;
  preflight?(request: AgentPreflightRequest): Promise<AgentProviderReadiness>;
  /** Kill the currently running agent process(es) without shutting the gateway down. Returns how many were killed. */
  cancelActive?(): Promise<number>;
  shutdown?(): Promise<void>;
}
