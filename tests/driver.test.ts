import { beforeAll, afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mayAccess } from "../src/modules/auth/policy";
import { assertDriverOwnership, assertOutcomeCommand } from "../src/modules/driver/policy";

test("driver routes are narrow; staff can schedule without gaining administrative access", () => {
  expect(mayAccess("driver", "GET", "/driver/profile")).toBe(true);
  expect(mayAccess("driver", "GET", "/driver/trips/123")).toBe(true);
  expect(mayAccess("driver", "POST", "/driver/stops/1/failed")).toBe(true);
  for (const path of ["/deliveries", "/orders", "/payments", "/driver/trips/1/dispatch"]) expect(mayAccess("driver", "POST", path)).toBe(false);
  expect(mayAccess("staff", "GET", "/driver/trips")).toBe(false);
  expect(mayAccess("staff", "POST", "/deliveries")).toBe(true);
  expect(mayAccess("staff", "GET", "/delivery-schedules")).toBe(true);
  expect(mayAccess("staff", "POST", "/users")).toBe(false);
});

test("ownership is checked independently of replay and stale outcomes conflict", () => {
  expect(() => assertDriverOwnership(1, 2)).toThrow("Assignment not found");
  const input = { status: "in_transit", version: 1, currentVersion: 2, actorId: 1, key: "key", outcome: "failed", reason: "Closed" };
  expect(() => assertOutcomeCommand(input)).toThrow("Assignment changed");
  expect(assertOutcomeCommand({ ...input, status: "returning", existing: { actor_id: 1, operation_key: "key", outcome: "failed", reason: "Closed" } })).toBe("replay");
  expect(() => assertOutcomeCommand({ ...input, existing: { actor_id: 1, operation_key: "key", outcome: "failed", reason: "Other" } })).toThrow("already has");
});

const testUrl = process.env.HYOPS_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("real database driver integration", () => {
  let sql: any, service: typeof import("../src/modules/driver/service").DriverService;
  let delivery: typeof import("../src/modules/deliveries/service").DeliveryService;
  let app: ReturnType<typeof import("../src/app").createApp>;
  beforeAll(async () => {
    if (!testUrl) throw new Error("Run through the disposable database fixture.");
    const url = new URL(testUrl);
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/hyops_test") throw new Error("Disposable loopback hyops_test database required.");
    require("./live/environment").fixtureEnvironment();
    process.env.GOOGLE_REFRESH_TOKEN = "fixture";
    process.env.DATABASE_URL = testUrl;
    process.env.JWT_SECRET = "driver-fixture-access-not-for-deployment";
    process.env.REFRESH_TOKEN_SECRET = "driver-fixture-refresh-not-for-deployment";
    sql = require("postgres").default(testUrl, { onnotice: () => {} });
    service = require("../src/modules/driver/service").DriverService;
    delivery = require("../src/modules/deliveries/service").DeliveryService;
    app = require("../src/app").createApp({ automation: false, externalIntegrations: false });
  });
  afterAll(async () => { await sql?.end(); await require("../src/db").db.$client.end({ timeout: 2 }); });
  beforeEach(async () => {
    await require("./driver-fixture").seedDriverFixture(sql);
  });
  async function schedule(warehouse = 1) {
    const result = await delivery.createDelivery({ order_ids: [warehouse], driver_id: warehouse === 1 ? 3 : 4, vehicle_id: warehouse,
      scheduled_date: "2099-01-01", scheduled_time: "10:00", delivery_type: "INTERNAL", delivery_allowance: 0, fuel: 0, toll: 0 }, warehouse);
    const [stop] = await sql`select id from deliveries_stops where delivery_id=${result.id}`;
    return { id: result.id, stopId: stop.id };
  }
  async function login(email: string, mobile = false) {
    const response = await app.handle(new Request("http://localhost/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "fixture-password", is_mobile: mobile }) }));
    expect(response.status).toBe(200);
    const tokens = await response.json();
    return `access_token=${tokens.access_token}; refresh_token=${tokens.refresh_token}`;
  }
  test("mobile login rejects non-driver accounts, invalid passwords and missing mobile flag", async () => {
    const send = (body: unknown) => app.handle(new Request("http://localhost/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    const wrong = await send({ email: "staff@example.test", password: "incorrect-password", is_mobile: true });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).errors.email).toBe("Invalid credentials.");
    const staff = await send({ email: "staff@example.test", password: "fixture-password", is_mobile: true });
    expect(staff.status).toBe(400);
    expect((await staff.json()).errors.email).toContain("Only driver accounts");
    expect((await send({ email: "driver1@example.test", password: "fixture-password" })).status).toBe(400);
    expect(await sql`select * from users where refresh_token is not null`).toHaveLength(0);
  });
  test("cookie login provides only assigned data, accurate historical money, and rejects another driver", async () => {
    const run = await schedule(); await schedule(2);
    const cookie = await login("driver1@example.test", true);
    const response = await app.handle(new Request("http://localhost/driver/trips", { headers: { cookie } }));
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.total).toBe(1);
    expect(payload.items[0].stops[0]).toMatchObject({ total: "24.68", collectNow: "24.68", address: "Saved address" });
    const other = await login("driver2@example.test", true);
    expect((await app.handle(new Request(`http://localhost/driver/trips/${run.id}`, { headers: { cookie: other } }))).status).toBe(404);
    expect((await app.handle(new Request("http://localhost/driver/trips?page=-1", { headers: { cookie } }))).status).toBe(400);
    await sql`update order_items set unit_price_snapshot=null where order_id=1`;
    expect((await service.trip(3, run.id)).stops[0].total).toBeNull();
  });
  test("staff reads/commands remain in their warehouse, including malicious assignment payloads", async () => {
    const own = await schedule(); const other = await schedule(2);
    const cookie = await login("staff@example.test");
    const list = await app.handle(new Request("http://localhost/deliveries", { headers: { cookie } }));
    expect((await list.json()).map((r: any) => r.delivery_id)).toEqual([own.id]);
    expect((await app.handle(new Request(`http://localhost/deliveries/${other.id}/dispatch`, { method: "POST", headers: { cookie } }))).status).toBe(404);
    const reassigned = await app.handle(new Request(`http://localhost/deliveries/${own.id}/assignment`, { method: "PATCH", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ driver_id: 4, vehicle_id: 2, delivery_version: 1 }) }));
    expect(reassigned.status).toBe(403);
    expect((await reassigned.json()).message).toContain("same authorized warehouse");
  });
  test("failed outcomes are idempotent; stock returns and reserves once at warehouse completion", async () => {
    const run = await schedule(); await delivery.dispatchDelivery(run.id, 1);
    const command = { version: 2, operationKey: crypto.randomUUID(), reason: "Store closed" };
    let denied: unknown;
    try { await service.outcome(4, run.stopId, command, "failed"); } catch (e) { denied = e; }
    expect(denied).toBeInstanceOf(Error);
    expect((denied as Error).message).toContain("Assignment not found");
    await service.outcome(3, run.stopId, command, "failed");
    await service.outcome(3, run.stopId, command, "failed");
    expect(await sql`select * from driver_stop_outcomes`).toHaveLength(1);
    expect((await sql`select quantity,reserved from inventory where id=1`)[0]).toMatchObject({ quantity: 8, reserved: 0 });
    expect((await service.trip(3, run.id)).status).toBe("returning");
    expect((await service.history(3)).items[0]).toMatchObject({ status: "failed", reason: "Store closed" });
    await delivery.completeDelivery(run.id, 1); await delivery.completeDelivery(run.id, 1);
    expect((await sql`select quantity,reserved from inventory where id=1`)[0]).toMatchObject({ quantity: 10, reserved: 2 });
    expect((await sql`select status,stock_reserved from orders where id=1`)[0]).toMatchObject({ status: "SCHEDULING", stock_reserved: true });
    expect(await sql`select * from stock_movements where kind='delivery_return'`).toHaveLength(1);
  });
  test("driver success writes through API, preserves payment records, and checks ownership before replay", async () => {
    const run = await schedule(); await delivery.dispatchDelivery(run.id, 1);
    const cookie = await login("driver1@example.test", true);
    const command = { version: 2, operationKey: crypto.randomUUID() };
    const request = () => new Request(`http://localhost/driver/stops/${run.stopId}/delivered`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(command) });
    expect((await app.handle(request())).status).toBe(200);
    expect((await app.handle(request())).status).toBe(200);
    expect(await sql`select * from payments`).toHaveLength(0);
    await sql`update deliveries set driver_id=4 where id=${run.id}`;
    expect((await app.handle(request())).status).toBe(404);
    expect(await sql`select * from audit_logs where action like '%driver/stops%'`).not.toHaveLength(0);
  });
  test("concurrent conflicting outcomes commit exactly one result", async () => {
    const run = await schedule(); await delivery.dispatchDelivery(run.id, 1);
    const results = await Promise.allSettled([
      service.outcome(3, run.stopId, { version: 2, operationKey: crypto.randomUUID() }, "delivered"),
      service.outcome(3, run.stopId, { version: 2, operationKey: crypto.randomUUID(), reason: "Unavailable" }, "failed"),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await sql`select * from driver_stop_outcomes`).toHaveLength(1);
  });
});
