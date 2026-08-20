import { type CommandRunner, runCommand } from "./command-probe.js";
import { DriverRegistry } from "./driver-registry.js";
import { ScriptPlatformDriver } from "./script-platform-driver.js";
import { TARGET_CONTRACT } from "./platform-driver.js";

const resolvePackage = (name: string) => ({
  id: name,
  command: "node",
  args: ["-e", `require.resolve(${JSON.stringify(name)})`],
});

export function createDefaultDriverRegistry(runner: CommandRunner = runCommand): DriverRegistry {
  const contract = TARGET_CONTRACT;
  return new DriverRegistry([
    new ScriptPlatformDriver("web", contract.web.script, contract.web.packages.map(resolvePackage), runner),
    new ScriptPlatformDriver("ios-simulator", contract["ios-simulator"].script, [
      { id: "simctl", command: "xcrun", args: ["--find", "simctl"] },
      ...contract["ios-simulator"].packages.map(resolvePackage),
    ], runner),
    new ScriptPlatformDriver("android-emulator", contract["android-emulator"].script, [
      { id: "adb", command: "adb", args: ["version"] },
      { id: "android-emulator", command: "emulator", args: ["-list-avds"] },
      ...contract["android-emulator"].packages.map(resolvePackage),
    ], runner),
    new ScriptPlatformDriver("electron", contract.electron.script, contract.electron.packages.map(resolvePackage), runner),
  ]);
}
