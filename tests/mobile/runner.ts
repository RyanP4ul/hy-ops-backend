import { fixtureEnvironment } from "../live/environment";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

async function main() {
  fixtureEnvironment();
  const root = resolve(process.cwd(), "../..");
  const device = process.env.HYOPS_MOBILE_DEVICE ?? "emulator-5554";
  if (!/^[\w.-]+$/.test(device)) throw new Error("Invalid mobile test device ID.");
  const adb = process.env.HYOPS_ADB ?? "D:/Android/Sdk/platform-tools/adb.exe";
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    const server = Bun.spawn([process.execPath, "tests/mobile/server.ts"], { cwd: process.cwd(), env: process.env, stdout: "inherit", stderr: "inherit" });
    children.push(server);
    let ready = false;
    for (let i = 0; i < 360; i++) {
      if (server.exitCode !== null) throw new Error("Device fixture failed to start.");
      try { const response = await fetch("http://127.0.0.1:5192/__test__/ready", { headers: { "x-hyops-fixture": "driver-device-checks" }, signal: AbortSignal.timeout(1000) }); if (response.ok) { ready = true; break; } } catch { /* Starting. */ }
      await Bun.sleep(500);
    }
    if (!ready) throw new Error("Device fixture readiness timed out.");
    execFileSync(adb, ["-s", device, "reverse", "tcp:5192", "tcp:5192"], { windowsHide: true });
    for (const target of ["device_acceptance_test.dart", "restart_acceptance_test.dart"]) {
      // Flutter otherwise uninstalls the test app on teardown, erasing secure storage.
      const preserveApp = target === "device_acceptance_test.dart" ? " --no-uninstall" : "";
      const command = `D:\\SDK\\flutter\\bin\\flutter.bat test --no-pub -d ${device}${preserveApp} --timeout 5m --dart-define=API_URL=http://127.0.0.1:5192 --dart-define=WS_URL=ws://127.0.0.1:5192/ws integration_test/${target}`;
      const test = Bun.spawn(["cmd.exe", "/d", "/s", "/c", command], { cwd: resolve(root, "hyops_flutter"), env: { ...process.env, TEMP: resolve(root, ".tmp"), TMP: resolve(root, ".tmp"), GRADLE_USER_HOME: resolve(root, ".tmp/gradle"), GRADLE_OPTS: `-Djava.io.tmpdir=${resolve(root, ".tmp")}` }, stdout: "inherit", stderr: "inherit" });
      children.push(test);
      if (await test.exited) throw new Error(`Device checks failed: ${target}`);
      execFileSync(adb, ["-s", device, "shell", "am", "force-stop", "com.example.hyops_flutter"], { windowsHide: true });
    }
  } finally {
    try { execFileSync(adb, ["-s", device, "reverse", "--remove", "tcp:5192"], { windowsHide: true }); } catch { /* Already disconnected. */ }
    for (const child of children.reverse()) {
      if (child.exitCode === null) { try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { child.kill(); } }
      await child.exited;
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
