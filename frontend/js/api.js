export class HiveApi {
  constructor(fetcher = globalThis.fetch.bind(globalThis)) {
    this.fetcher = fetcher;
  }

  bootstrap() {
    return this.request("/api/bootstrap");
  }

  setupStatus() {
    return this.request("/api/setup/status");
  }

  saveSetupApiKey(provider, apiKey) {
    return this.request("/api/setup/api-key", { method: "POST", body: JSON.stringify({ provider, apiKey }) });
  }

  platforms() {
    return this.request("/api/tester/platforms");
  }

  sendBrain(text, attachments = []) {
    const payload = attachments.length > 0 ? { text, attachments } : { text };
    return this.request("/api/brain/messages", { method: "POST", body: JSON.stringify(payload) });
  }

  uploadAttachment({ name, mime, data }) {
    return this.request("/api/brain/attachments", { method: "POST", body: JSON.stringify({ name, mime, data }) });
  }

  approvePlan(planId) {
    return this.request(`/api/plans/${planId}/approve`, { method: "POST" });
  }

  retryWorkItem(workItemId) {
    return this.request(`/api/work-items/${workItemId}/retry`, { method: "POST" });
  }

  cancelWorkItem(workItemId) {
    return this.request(`/api/work-items/${workItemId}/cancel`, { method: "POST" });
  }

  repairDiscord() {
    return this.request("/api/discord/repair", { method: "POST" });
  }

  knowledgeZone(zone) {
    return this.request(`/api/knowledge/zones/${encodeURIComponent(zone)}`);
  }

  knowledgeNotes(zone, slug) {
    return this.request(`/api/knowledge/zones/${encodeURIComponent(zone)}/${encodeURIComponent(slug)}`);
  }

  knowledgeNote(notePath) {
    return this.request(`/api/knowledge/note?path=${encodeURIComponent(notePath)}`);
  }

  knowledgeInbox(projectSlug) {
    const query = projectSlug ? `?project=${encodeURIComponent(projectSlug)}` : "";
    return this.request(`/api/knowledge/inbox${query}`);
  }

  resolveProposal(id, resolution) {
    return this.request("/api/knowledge/inbox/resolve", {
      method: "POST",
      body: JSON.stringify({ id, resolution }),
    });
  }

  updateSettings(agentId, settings) {
    return this.request(`/api/agents/${agentId}/settings`, { method: "PATCH", body: JSON.stringify(settings) });
  }

  agentProfile(agentId) {
    return this.request(`/api/agents/${encodeURIComponent(agentId)}/profile`);
  }

  saveAgentSoul(agentId, content) {
    return this.request(`/api/agents/${encodeURIComponent(agentId)}/soul`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    });
  }

  async request(url, options = {}) {
    // Only declare a JSON body when one is actually sent: several endpoints are
    // POSTs with no payload, and an empty body with this content type is a parse
    // error rather than an empty object.
    const headers = options.body === undefined
      ? { ...(options.headers || {}) }
      : { "content-type": "application/json", ...(options.headers || {}) };
    const response = await this.fetcher(url, { ...options, headers });
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) {
      const detail = typeof payload === "object" && payload ? payload.error || payload.message : payload;
      throw new Error(detail || `Request failed (${response.status})`);
    }
    return payload;
  }
}
