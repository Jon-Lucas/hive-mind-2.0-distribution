import fs from "node:fs";
import path from "node:path";
import { runCommand, type CommandRequirement, type CommandRunner } from "./command-probe.js";
import type { DriverAvailability, DriverContext, PlatformDriver, TargetRunResult, TestTarget } from "./platform-driver.js";
import { writeReceipt } from "./platform-receipt.js";

/**
 * A failing suite says why at the end of its output, and usually on stdout: the
 * head of stderr is install noise and deprecation warnings. Reporting that head
 * told Developer nothing about the actual failure, so keep the tail of both
 * streams with stdout first.
 */
function tail(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `…${trimmed.slice(-limit)}`;
}

function failureDetail(stdout: string, stderr: string, script: string): string {
  const sections: string[] = [];
  const out = tail(stdout, 1_500);
  const err = tail(stderr, 1_500);
  if (out) sections.push(`stdout tail:\n${out}`);
  if (err) sections.push(`stderr tail:\n${err}`);
  return sections.join("\n\n") || `${script} failed`;
}

export class ScriptPlatformDriver implements PlatformDriver {
  constructor(
    readonly target: TestTarget,
    private readonly script: string,
    private readonly requirements: CommandRequirement[],
    private readonly runner: CommandRunner = runCommand,
  ) {}

  async probe(context: DriverContext): Promise<DriverAvailability> {
    const checks: DriverAvailability["checks"] = [];
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(context.cwd, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      const present = Boolean(manifest.scripts?.[this.script]);
      checks.push({ id: `script:${this.script}`, status: present ? "present" : "missing", detail: present ? `npm script ${this.script} is configured` : `missing npm script ${this.script}` });
    } catch (error) {
      checks.push({ id: "package.json", status: "missing", detail: error instanceof Error ? error.message : String(error) });
    }
    for (const requirement of this.requirements) {
      const result = await this.runner(requirement.command, requirement.args, context.cwd);
      checks.push({
        id: requirement.id,
        status: result.status === 0 ? "present" : "missing",
        detail: result.status === 0 ? `${requirement.id} is ready` : (result.stderr.trim() || `${requirement.id} unavailable`),
        command: [requirement.command, ...requirement.args].join(" "),
      });
    }
    return { target: this.target, status: checks.every((check) => check.status === "present") ? "available" : "unavailable", checks };
  }

  async run(context: DriverContext): Promise<TargetRunResult> {
    const result = await this.runner("npm", ["run", this.script], context.cwd);
    const status = result.status === 0 ? "passed" : "failed";
    const receipt = writeReceipt(context.evidenceDir, {
      target: this.target,
      commit: context.commit,
      status,
      command: `npm run ${this.script}`,
      exitCode: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      finishedAt: new Date().toISOString(),
    });
    return {
      target: this.target,
      status,
      evidence: [receipt],
      detail: status === "passed" ? `${this.script} passed` : failureDetail(result.stdout, result.stderr, this.script),
    };
  }
}
