import type { HiveDatabase } from "../storage/database.js";
import { isSupportedSelection } from "./model-catalog.js";
import { WorkflowConflictError } from "../workflow/workflow-service.js";

export interface AgentRecord {
  id: string;
  name: string;
  role: string;
  status: string;
  provider: string;
  model: string;
  effort: string;
  sort_order: number;
}

export class AgentService {
  constructor(private readonly database: HiveDatabase) {}

  list(): AgentRecord[] {
    return this.database.sqlite.prepare("SELECT * FROM agents ORDER BY sort_order").all() as AgentRecord[];
  }

  updateSettings(id: string, selection: { provider: string; model: string; effort: string }): AgentRecord {
    if (!isSupportedSelection(selection.provider, selection.model, selection.effort)) {
      throw new WorkflowConflictError("Invalid provider, model, or effort selection");
    }
    const updated = this.database.sqlite.prepare(`
      UPDATE agents SET provider = ?, model = ?, effort = ? WHERE id = ?
    `).run(selection.provider, selection.model, selection.effort, id);
    if (updated.changes !== 1) throw new WorkflowConflictError("agent not found");
    return this.database.sqlite.prepare("SELECT * FROM agents WHERE id = ?").get(id) as AgentRecord;
  }
}
