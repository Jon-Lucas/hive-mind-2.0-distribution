export interface RealtimeClient {
  readonly readyState: number;
  send(message: string): void;
}

export class RealtimeHub {
  private readonly clients = new Set<RealtimeClient>();

  get size(): number {
    return this.clients.size;
  }

  add(client: RealtimeClient): () => void {
    this.clients.add(client);
    return () => this.clients.delete(client);
  }

  publish(type: string, payload: unknown): void {
    const message = JSON.stringify({ type, payload, at: new Date().toISOString() });
    for (const client of this.clients) {
      if (client.readyState !== 1) {
        this.clients.delete(client);
        continue;
      }
      try {
        client.send(message);
      } catch {
        this.clients.delete(client);
      }
    }
  }
}
