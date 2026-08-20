/**
 * User-requested cancellation flags per work item. Killing the agent process
 * alone is not enough: the orchestrator's cycle loop would treat the death as
 * an ordinary failure and could spin up the next phase. The orchestrator
 * checks this registry at phase boundaries and stops the work item cleanly.
 */
export class CancellationRegistry {
  private readonly requested = new Set<number>();

  request(workItemId: number): void {
    this.requested.add(workItemId);
  }

  isRequested(workItemId: number): boolean {
    return this.requested.has(workItemId);
  }

  clear(workItemId: number): void {
    this.requested.delete(workItemId);
  }
}
