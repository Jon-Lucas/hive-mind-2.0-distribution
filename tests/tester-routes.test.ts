import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerTesterRoutes } from "../src/modules/tester/routes.js";
import { DriverRegistry } from "../src/tester/driver-registry.js";
import type { PlatformDriver, TestTarget } from "../src/tester/platform-driver.js";

const targets = ["web", "ios-simulator", "android-emulator", "electron"] as TestTarget[];

describe("Tester platform routes", () => {
  it("returns structured read-only availability for every v1 target", async () => {
    const drivers = new DriverRegistry(targets.map((target): PlatformDriver => ({
      target,
      async probe() {
        return { target, status: target === "android-emulator" ? "unavailable" : "available", checks: [{ id: "host", status: "present", detail: "checked" }] };
      },
      async run() { throw new Error("readiness must not run a driver"); },
    })));
    const app = Fastify();
    await registerTesterRoutes(app, drivers, () => ({ cwd: "/tmp/project", commit: "readiness-probe", evidenceDir: "/tmp/evidence" }));

    const response = await app.inject({ method: "GET", url: "/api/tester/platforms" });

    expect(response.statusCode).toBe(200);
    expect(response.json().platforms).toHaveLength(4);
    expect(response.json().platforms[0]).toMatchObject({ target: "web", status: "available" });
    await app.close();
  });

  it("reports pending without probing before an exact Tester checkout exists", async () => {
    const app = Fastify();
    let probes = 0;
    const registry = new DriverRegistry(targets.map((target): PlatformDriver => ({
      target,
      async probe() { probes += 1; return { target, status: "available", checks: [] }; },
      async run() { return { target, status: "passed", evidence: [], detail: "passed" }; },
    })));
    await registerTesterRoutes(app, registry, () => undefined);

    const response = await app.inject({ method: "GET", url: "/api/tester/platforms" });

    expect(probes).toBe(0);
    expect(response.json().platforms[0]).toMatchObject({ target: "web", status: "unavailable" });
    expect(response.json().platforms[0].checks[0].detail).toContain("exact Tester checkout");
    await app.close();
  });
});
