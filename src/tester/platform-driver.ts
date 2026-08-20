export const TEST_TARGETS = ["web", "ios-simulator", "android-emulator", "electron"] as const;
export type TestTarget = (typeof TEST_TARGETS)[number];

/** The npm script each target runs, and the packages it must resolve in the project. */
export const TARGET_CONTRACT: Record<TestTarget, { script: string; packages: string[] }> = {
  "web": { script: "test:web", packages: ["playwright"] },
  "ios-simulator": { script: "test:ios", packages: ["appium"] },
  "android-emulator": { script: "test:android", packages: ["appium"] },
  "electron": { script: "test:electron", packages: ["playwright", "electron"] },
};

export type DriverAvailabilityStatus = "available" | "unavailable";
export type TargetRunStatus = "passed" | "failed" | "unavailable" | "error";

export interface DriverCheck {
  id: string;
  status: "present" | "missing" | "error";
  detail: string;
  command?: string;
}

export interface DriverAvailability {
  target: TestTarget;
  status: DriverAvailabilityStatus;
  checks: DriverCheck[];
}

export interface DriverContext {
  cwd: string;
  commit: string;
  evidenceDir: string;
}

export interface TargetRunResult {
  target: TestTarget;
  status: TargetRunStatus;
  evidence: string[];
  detail: string;
  /** True when this result was replayed from a stored receipt instead of run. */
  reused?: boolean;
}

export interface PlatformDriver {
  readonly target: TestTarget;
  probe(context: DriverContext): Promise<DriverAvailability>;
  run(context: DriverContext): Promise<TargetRunResult>;
}

export function validateTestTargets(targets: readonly string[]): TestTarget[] {
  const seen = new Set<string>();
  return targets.map((target) => {
    if (!TEST_TARGETS.includes(target as TestTarget)) throw new Error(`unsupported test target: ${target}`);
    if (seen.has(target)) throw new Error(`duplicate test target: ${target}`);
    seen.add(target);
    return target as TestTarget;
  });
}
