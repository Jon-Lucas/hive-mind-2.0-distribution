import fs from "node:fs";
import path from "node:path";
import { runCommand, type CommandRunner } from "./command-probe.js";
import {
  TEST_TARGETS,
  type DriverAvailability,
  type DriverContext,
  type PlatformDriver,
  type TargetRunResult,
  type TestTarget,
  validateTestTargets,
} from "./platform-driver.js";
import { readPassingReceipt } from "./platform-receipt.js";

function attestEvidenceDirectory(evidenceDir: string): string {
  const stat = fs.lstatSync(evidenceDir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("evidence directory must be a real directory");
  return fs.realpathSync(evidenceDir);
}

export class DriverRegistry {
  private readonly drivers = new Map<TestTarget, PlatformDriver>();

  constructor(drivers: PlatformDriver[], private readonly runner: CommandRunner = runCommand) {
    for (const driver of drivers) {
      if (this.drivers.has(driver.target)) throw new Error(`duplicate platform driver: ${driver.target}`);
      this.drivers.set(driver.target, driver);
    }
    for (const target of TEST_TARGETS) {
      if (!this.drivers.has(target)) throw new Error(`missing platform driver: ${target}`);
    }
  }

  async probeAll(context: DriverContext): Promise<DriverAvailability[]> {
    return Promise.all(TEST_TARGETS.map((target) => this.drivers.get(target)!.probe(context)));
  }

  /**
   * The Tester checkout is a fresh worktree of the exact commit and node_modules
   * is gitignored, so a commit that correctly declares its test packages still
   * cannot resolve them. Nothing else installed them, so every target probed as
   * unavailable no matter what Developer committed, and the cycle could only
   * ever burn itself out against maxCycles.
   */
  private async installDependencies(cwd: string): Promise<string | undefined> {
    if (!fs.existsSync(path.join(cwd, "package.json"))) return undefined;
    if (fs.existsSync(path.join(cwd, "node_modules"))) return undefined;
    const reproducible = fs.existsSync(path.join(cwd, "package-lock.json"));
    const command = reproducible ? "ci" : "install";
    const result = await this.runner("npm", [command, "--no-audit", "--no-fund"], cwd);
    if (result.status === 0) return undefined;
    return result.stderr.trim() || result.stdout.trim() || `npm ${command} exited ${result.status}`;
  }

  async runRequired(targets: readonly string[], context: DriverContext): Promise<TargetRunResult[]> {
    const requested = validateTestTargets(targets);
    const expectedEvidenceRoot = attestEvidenceDirectory(context.evidenceDir);
    // A suite that already passed at this exact commit is a checkpoint. Replaying
    // its receipt is what lets a restart resume mid-job: without it, a backend
    // restart after a 30-minute emulator pass pays for that pass a second time.
    const checkpoints = new Map<TestTarget, TargetRunResult>();
    for (const target of requested) {
      const reused = readPassingReceipt(expectedEvidenceRoot, target, context.commit);
      if (reused) checkpoints.set(target, reused);
    }
    const pending = requested.filter((target) => !checkpoints.has(target));
    // Nothing left to run means nothing to install for.
    const installFailure = pending.length > 0 ? await this.installDependencies(context.cwd) : undefined;
    if (installFailure !== undefined) {
      return requested.map((target) => checkpoints.get(target) ?? {
        target,
        status: "unavailable" as const,
        evidence: [],
        detail: `dependency install failed: ${installFailure}`,
      });
    }
    const results: TargetRunResult[] = [];
    for (const target of requested) {
      const checkpoint = checkpoints.get(target);
      if (checkpoint) {
        results.push(checkpoint);
        continue;
      }
      const driver = this.drivers.get(target)!;
      const availability = await driver.probe(context);
      if (availability.status !== "available") {
        results.push({ target, status: "unavailable", evidence: [], detail: availability.checks.map((check) => check.detail).join("; ") || "driver unavailable" });
        continue;
      }
      const result = await driver.run(context);
      const evidenceRoot = attestEvidenceDirectory(context.evidenceDir);
      if (evidenceRoot !== expectedEvidenceRoot) throw new Error("evidence directory changed during platform execution");
      if (result.status === "passed") {
        if (result.evidence.length === 0) throw new Error(`invalid or missing platform evidence: ${target}`);
        const prefix = evidenceRoot + path.sep;
        result.evidence = result.evidence.map((entry) => {
          const candidate = path.resolve(context.evidenceDir, entry);
          if (!fs.existsSync(candidate)) throw new Error(`invalid or missing platform evidence: ${entry}`);
          const resolved = fs.realpathSync(candidate);
          if (!resolved.startsWith(prefix) || !fs.statSync(resolved).isFile()) {
            throw new Error(`invalid or missing platform evidence: ${entry}`);
          }
          return resolved;
        });
      }
      results.push(result);
    }
    return results;
  }
}
