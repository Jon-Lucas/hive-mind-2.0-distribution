import type { FastifyInstance } from "fastify";
import type { DriverRegistry } from "../../tester/driver-registry.js";
import { TEST_TARGETS, type DriverContext } from "../../tester/platform-driver.js";

export type TesterProbeContextResolver = () => DriverContext | undefined;

export async function registerTesterRoutes(
  app: FastifyInstance,
  drivers: DriverRegistry,
  resolveContext: TesterProbeContextResolver,
): Promise<void> {
  app.get("/api/tester/platforms", async () => {
    const context = resolveContext();
    if (!context) {
      return {
        platforms: TEST_TARGETS.map((target) => ({
          target,
          status: "unavailable" as const,
          checks: [{
            id: "exact-checkout",
            status: "missing" as const,
            detail: "pending exact Tester checkout for the current Developer commit",
          }],
        })),
      };
    }
    return { platforms: await drivers.probeAll(context) };
  });
}
