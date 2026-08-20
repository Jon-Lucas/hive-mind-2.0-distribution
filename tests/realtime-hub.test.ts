import { describe, expect, it } from "vitest";
import { RealtimeHub, type RealtimeClient } from "../src/realtime/realtime-hub.js";

class Client implements RealtimeClient {
  readonly OPEN = 1;
  readyState = 1;
  messages: string[] = [];
  send(message: string): void { this.messages.push(message); }
}

describe("realtime hub", () => {
  it("broadcasts typed events to open clients and drops closed clients", () => {
    const hub = new RealtimeHub();
    const open = new Client();
    const closed = new Client();
    closed.readyState = 3;
    hub.add(open);
    hub.add(closed);

    hub.publish("workflow.changed", { workItemId: 12 });

    expect(open.messages.map((message) => JSON.parse(message))).toEqual([
      expect.objectContaining({ type: "workflow.changed", payload: { workItemId: 12 } }),
    ]);
    expect(closed.messages).toEqual([]);
    expect(hub.size).toBe(1);
  });
});
