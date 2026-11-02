import { fixtureEnvironment } from "./environment";
import postgres from "postgres";
import bcrypt from "bcrypt";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";

async function main() {
const url = fixtureEnvironment();
const sql = postgres(url, { onnotice: () => {} });
const children: ReturnType<typeof Bun.spawn>[] = [];
try {
  const hash = await bcrypt.hash("Fixture-password-2026", 10);
  for (const [email, name, role] of [
    ["admin@example.test", "Live Admin", "admin"], ["other@example.test", "Other Admin", "admin"],
    ["staff@example.test", "Live Staff", "staff"], ["customer@example.test", "Live Customer", "customer"],
    ["driver@example.test", "Live Driver", "driver"],
  ] as const) await sql`insert into users(email,name,password_hash,role,created_at,updated_at) values (${email},${name},${hash},${role},0,0)`;
  await sql`insert into warehouses(name,street_address,city,state,zip_code,latitude,longitude,created_at,updated_at) values ('Live warehouse','Fixture street','Fixture city','Fixture province','0000','14.5','121.1',0,0)`;
  await sql`insert into staffs(user_id,warehouse_id) values(3,1)`;
  await sql`insert into customers(user_id,company_name,phone_number) values (4,'Live customer','09000000000')`;
  await sql`insert into customer_addresses(customer_id,address_line,barangay,city_municipality,province,latitude,longitude) values (1,'Fixture street','Fixture barangay','Fixture city','Fixture province','14.6','121.2')`;
  await sql`insert into drivers(user_id,warehouse_id,phone_number) values (5,1,'09000000000')`;
  await sql`insert into vehicles(warehouse_id,plate_number,image,created_at,updated_at) values (1,'LIVE-001','',0,0)`;
  await sql`insert into products(name) values ('Live product')`;
  await sql`insert into product_variants(product_id,name,sku,price,unit) values (1,'Live variant','LIVE-SKU',12.34,'piece')`;
  await sql`insert into inventory(warehouse_id,product_id,product_variant_id,quantity,created_at,updated_at) values (1,1,1,10000,0,0)`;
  for (const [name, value] of Object.entries({ customer_order_limit: '100', refresh_interval_ms: '60000', low_stock_threshold: '10', high_stock_threshold: '100', max_order_per_vehicle: '10' })) {
    await sql`insert into settings(name,value,created_at,updated_at) values (${name},${value},0,0)`;
  }
  // A representative pagination dataset, deliberately larger than one page.
  await sql`insert into products(name) select 'Performance product ' || n from generate_series(1,500) n`;
  for (const port of [5180, 5181]) {
    const child = Bun.spawn([process.execPath, "tests/live/server.ts"], { cwd: process.cwd(), env: { ...process.env, HYOPS_FIXTURE_PORT: String(port) }, stdout: "inherit", stderr: "inherit" });
    children.push(child);
    let ready = false;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Fixture ${port} exited (${child.exitCode}) before readiness.`);
      try { const response = await fetch(`http://127.0.0.1:${port}/auth/me`, { signal: AbortSignal.timeout(1000) }); if (response.status === 401) { ready = true; break; } } catch { /* starting */ }
      await Bun.sleep(200);
    }
    if (!ready) throw new Error(`Fixture ${port} did not start.`);
  }
  const frontend = resolve(process.cwd(), "../frontend");
  const frontendEnv = { ...process.env, API_URL: "http://127.0.0.1:5180", NEXT_PUBLIC_API_URL: "http://127.0.0.1:5180", NEXT_PUBLIC_WS_URL: "ws://127.0.0.1:5180/ws", NEXT_PUBLIC_DEBUG: "false", HYOPS_LIVE_SERVER_STARTED: "1" };
  // Own the server process tree so Windows teardown cannot strand Next workers.
  try { await fetch("http://127.0.0.1:3100", { signal: AbortSignal.timeout(500) }); throw new Error("Fixture port 3100 is already in use."); }
  catch (error) { if (error instanceof Error && error.message.includes("already in use")) throw error; }
  const next = Bun.spawn(["node", resolve(frontend, "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", "3100"], { cwd: frontend, env: frontendEnv, stdout: "inherit", stderr: "inherit" });
  children.push(next);
  let frontendReady = false;
  const frontendDeadline = Date.now() + 120_000;
  while (Date.now() < frontendDeadline) {
    if (next.exitCode !== null) throw new Error(`Next fixture exited (${next.exitCode}).`);
    try { const response = await fetch("http://127.0.0.1:3100", { signal: AbortSignal.timeout(2000) }); if (response.ok) { frontendReady = true; break; } } catch { /* starting */ }
    await Bun.sleep(200);
  }
  if (!frontendReady) throw new Error("Next fixture did not start.");
  const selection = Bun.argv[2] === "Driver" ? ["driver-integration.spec.ts", "dashboard-map.spec.ts", "sidebar-active.spec.ts", "inventory-variants.spec.ts", "login-ux.spec.ts", "delivery-calendar.spec.ts", "communications.spec.ts"] : Bun.argv[2] === "Authorization" ? ["authorization.spec.ts"] : Bun.argv[2] === "Operations" ? ["operations.spec.ts", "selected-workflows.spec.ts", "deliveries.spec.ts"] : Bun.argv[2] === "UIUX" ? ["uiux.spec.ts", "selected-workflows.spec.ts", "--grep", "UIUX|Users |Vehicles |Scheduled assignments|Warehouse|Calendar|Customer profile"] : Bun.argv[2] === "Deliveries" ? ["deliveries.spec.ts"] : Bun.argv[2] === "Orders" ? ["orders.spec.ts"] : Bun.argv[2] === "DashboardReports" ? ["selected-workflows.spec.ts", "--grep", "Dashboard|Reports|Report URL"] : Bun.argv[2] === "Selected" ? ["selected-workflows.spec.ts"] : [];
  const filter = Bun.argv[3] ? ["--grep", Bun.argv[3]] : [];
  const suite = Bun.spawn(["node", resolve(frontend, "node_modules/@playwright/test/cli.js"), "test", "--config", "playwright.live.config.ts", ...selection, ...filter], { cwd: frontend, env: frontendEnv, stdout: "inherit", stderr: "inherit" });
  children.push(suite);
  const code = await suite.exited;
  if (code) throw new Error(`Live verification failed (${code}).`);
} finally {
  for (const child of children.reverse()) {
    if (child.exitCode === null) {
      if (process.platform === "win32") {
        try { execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); }
        catch { child.kill(); }
      } else child.kill();
    }
    await child.exited;
  }
  await sql.end({ timeout: 2 });
}
}
main().catch(error => { console.error(error); process.exitCode = 1; });
