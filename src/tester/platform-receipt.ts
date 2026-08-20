import fs from "node:fs";
import path from "node:path";
import type { TargetRunResult, TestTarget } from "./platform-driver.js";

/**
 * A platform run is identified by (target, exact commit): the suite, the app,
 * and the scripts all come out of that commit's checkout, so the same pair can
 * only mean the same run. Naming the receipt after the pair is what makes a
 * finished run resumable — a restart between the suite passing and the Tester
 * adjudicating it re-reads the receipt instead of re-booting the emulator.
 */
export interface PlatformReceipt {
  target: TestTarget;
  commit: string;
  status: "passed" | "failed";
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  finishedAt: string;
}

export function receiptPath(evidenceDir: string, target: TestTarget, commit: string): string {
  return path.join(evidenceDir, `${target}-${commit.slice(0, 12)}.json`);
}

export function writeReceipt(evidenceDir: string, receipt: PlatformReceipt): string {
  fs.mkdirSync(evidenceDir, { recursive: true });
  const file = receiptPath(evidenceDir, receipt.target, receipt.commit);
  fs.writeFileSync(file, JSON.stringify(receipt, null, 2));
  return file;
}

/**
 * Only a passing receipt is reusable. A failed one is not a checkpoint: the
 * item goes back to Developer and comes back at a different commit, so a
 * failure at this commit re-runs rather than being replayed from disk.
 */
export function readPassingReceipt(
  evidenceDir: string,
  target: TestTarget,
  commit: string,
): TargetRunResult | null {
  const file = receiptPath(evidenceDir, target, commit);
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  let receipt: Partial<PlatformReceipt>;
  try {
    receipt = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<PlatformReceipt>;
  } catch {
    return null;
  }
  if (receipt.target !== target || receipt.commit !== commit || receipt.status !== "passed") return null;
  return {
    target,
    status: "passed",
    evidence: [fs.realpathSync(file)],
    detail: `${receipt.command ?? "platform run"} passed at ${receipt.finishedAt ?? "an earlier run"}; resumed from its receipt without re-running`,
    reused: true,
  };
}
