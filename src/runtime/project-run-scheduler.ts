export type ProjectIdResolver = (workItemId: number) => number;
export type WorkItemRunner = (workItemId: number) => Promise<void>;
export type SchedulerErrorHandler = (workItemId: number, error: unknown) => void;
export interface ScheduleOptions { queueIfActive?: boolean }

export class ProjectRunScheduler {
  private readonly activeWorkItems = new Set<number>();
  private readonly activeProjects = new Set<number>();
  private readonly queuedWorkItems = new Set<number>();
  private readonly queues = new Map<number, number[]>();
  private readonly activeRuns = new Set<Promise<void>>();
  private accepting = true;

  constructor(
    private readonly resolveProjectId: ProjectIdResolver,
    private readonly runWorkItem: WorkItemRunner,
    private readonly onError: SchedulerErrorHandler = () => {},
  ) {}

  schedule(workItemId: number, options: ScheduleOptions = {}): boolean {
    if (!this.accepting) return false;
    if (this.queuedWorkItems.has(workItemId)) return false;
    const projectId = this.resolveProjectId(workItemId);
    if (this.activeWorkItems.has(workItemId) && !options.queueIfActive) return false;
    if (this.activeProjects.has(projectId)) {
      const queue = this.queues.get(projectId) ?? [];
      queue.push(workItemId);
      this.queues.set(projectId, queue);
      this.queuedWorkItems.add(workItemId);
      return true;
    }
    this.start(workItemId, projectId);
    return true;
  }

  stop(): void {
    this.accepting = false;
    this.queues.clear();
    this.queuedWorkItems.clear();
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.activeRuns]);
  }

  private start(workItemId: number, projectId: number): void {
    this.activeWorkItems.add(workItemId);
    this.activeProjects.add(projectId);
    let run!: Promise<void>;
    run = Promise.resolve()
      .then(() => this.runWorkItem(workItemId))
      .catch((error: unknown) => this.onError(workItemId, error))
      .finally(() => {
        this.activeRuns.delete(run);
        this.activeWorkItems.delete(workItemId);
        if (!this.accepting) {
          this.activeProjects.delete(projectId);
          return;
        }
        const queue = this.queues.get(projectId) ?? [];
        const next = queue.shift();
        if (queue.length === 0) this.queues.delete(projectId);
        else this.queues.set(projectId, queue);
        if (next === undefined) {
          this.activeProjects.delete(projectId);
          return;
        }
        this.queuedWorkItems.delete(next);
        this.start(next, projectId);
      });
    this.activeRuns.add(run);
    void run;
  }
}
