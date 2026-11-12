import { beforeAll, afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mayAccess } from "../src/modules/auth/policy";
import { assertDriverOwnership, assertOutcomeCommand } from "../src/modules/driver/policy";

test("driver routes are narrow; staff can schedule without gaining administrative access", () => {
  expect(mayAccess("driver", "GET", "/driver/profile")).toBe(true);
  expect(mayAccess("driver", "GET", "/driver/settings")).toBe(true);
  expect(mayAccess("driver", "POST", "/driver/settings")).toBe(false);
  expect(mayAccess("driver", "GET", "/settings")).toBe(false);
  expect(mayAccess("driver", "GET", "/driver/trips/123")).toBe(true);
  expect(mayAccess("driver", "POST", "/driver/stops/1/failed")).toBe(true);
  expect(mayAccess("driver", "POST", "/driver/stops/1/plan")).toBe(true);
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
  test("grouped stop planning syncs driver and fleet reads without changing outcomes", async () => {
    const groupId = crypto.randomUUID();
    await sql`insert into order_groups(id,group_number,customer_id) values(${groupId},'GRP-PLAN',1)`;
    await sql`update orders set order_group_id=${groupId},order_group_position=1 where id=1`;
    await sql`insert into orders(order_number,warehouse_id,customer_id,status,stock_reserved,payment_arrangement,shipping_address,shipping_latitude,shipping_longitude,order_group_id,order_group_position)
      values('ORDER-3',1,1,'SCHEDULING',true,'NET_30','Saved address',14.55,121.05,${groupId},2)`;
    const [order] = await sql`select id from orders where order_number='ORDER-3'`;
    await sql`insert into order_items(order_id,inventory_id,quantity,unit_price_snapshot,price_source) values(${order.id},1,1,12.34,'fixture')`;
    await sql`update inventory set reserved=3 where id=1`;
    const run = await delivery.createDelivery({ order_ids: [1, order.id], driver_id: 3, vehicle_id: 1,
      scheduled_date: "2099-01-01", scheduled_time: "10:00", delivery_type: "INTERNAL", delivery_allowance: 0, fuel: 0, toll: 0 }, 1);
    const stops = await sql`select id from deliveries_stops where delivery_id=${run.id} order by leg_index,id`;
    const cookie = await login("driver1@example.test", true);
    const command = (stopId: number, action: string, auth = cookie) => app.handle(new Request(`http://localhost/driver/stops/${stopId}/plan`, {
      method: "POST", headers: { cookie: auth, "content-type": "application/json" }, body: JSON.stringify({ action }),
    }));
    expect((await command(stops[0].id, "skip")).status).toBe(409);
    await delivery.dispatchDelivery(run.id, 1);
    const other = await login("driver2@example.test", true);
    expect((await command(stops[0].id, "skip", other)).status).toBe(404);
    expect((await command(stops[0].id, "invalid")).status).toBe(400);
    const stock = await sql`select quantity,reserved from inventory where id=1`;
    let resourceChanged!: (event: any) => void;
    let driverChanged!: (event: any) => void;
    const resourceEvent = new Promise<any>(resolve => { resourceChanged = resolve; });
    const driverEvent = new Promise<any>(resolve => { driverChanged = resolve; });
    const resourceListener = await sql.listen("hyops_resource_changed", (raw: string) => resourceChanged(JSON.parse(raw)));
    const driverListener = await sql.listen("hyops_driver_changed", (raw: string) => driverChanged(JSON.parse(raw)));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      expect((await command(stops[0].id, "skip")).status).toBe(200);
      const events = await Promise.race([
        Promise.all([resourceEvent, driverEvent]),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Missing committed plan notifications")), 3000); }),
      ]);
      expect(events[0]).toMatchObject({ type: "RESOURCE_CHANGED", payload: { resource: "deliveries" } });
      expect(events[1]).toMatchObject({ driverId: 3, deliveryId: run.id, kind: "updated" });
    } finally {
      clearTimeout(timeout);
      await resourceListener.unlisten();
      await driverListener.unlisten();
    }
    expect((await command(stops[1].id, "next")).status).toBe(200);
    const plan = { driverId: 3, nextStopId: stops[1].id, skippedStopIds: [stops[0].id] };
    const trip = await service.trip(3, run.id);
    expect(trip.stopPlan).toEqual(plan);
    expect(trip.stops.every(s => s.status === "pending")).toBe(true);
    expect(trip.status).toBe("in_transit");
    expect(await sql`select quantity,reserved from inventory where id=1`).toEqual(stock);
    expect(await sql`select * from driver_stop_outcomes`).toHaveLength(0);
    expect(await sql`select * from payments`).toHaveLength(0);
    const admin = await login("admin@example.test");
    const fleet = await app.handle(new Request("http://localhost/fleet", { headers: { cookie: admin } }));
    expect(fleet.status).toBe(200);
    const vehicle = (await fleet.json()).vehicles.find((v: any) => v.id === "1");
    expect(vehicle.stops[0]).toMatchObject({ status: "pending", skippedForNow: true, deliverNext: false });
    expect(vehicle.stops[1]).toMatchObject({ skippedForNow: false, deliverNext: true });
    // Concurrent skips merge under the delivery lock rather than overwriting a full client plan.
    await Promise.all(stops.map((s: any) => service.planStop(3, s.id, "skip")));
    expect((await service.trip(3, run.id)).stopPlan.skippedStopIds.sort()).toEqual(stops.map((s: any) => s.id).sort());
    expect((await service.trip(3, run.id)).status).toBe("in_transit");
    expect((await command(stops[0].id, "next")).status).toBe(200);
    expect((await service.trip(3, run.id)).stopPlan.nextStopId).toBe(stops[0].id);
    const version = (await service.trip(3, run.id)).version;
    await service.outcome(3, stops[0].id, { version, operationKey: crypto.randomUUID(), reason: "Closed" }, "failed");
    expect((await service.trip(3, run.id)).stopPlan.nextStopId).toBeNull();
    expect((await command(stops[0].id, "skip")).status).toBe(409);
    await sql`update deliveries set driver_id=4 where id=${run.id}`;
    expect((await service.trip(4, run.id)).stopPlan).toEqual({ driverId: 4, nextStopId: null, skippedStopIds: [] });
  });
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
  test("staff can submit grouped orders only from their warehouse and drivers cannot create them", async () => {
    await sql`insert into customer_addresses(customer_id,address_line,barangay,city_municipality,province,latitude,longitude) values(1,'Batch saved address','B','C','P','14.5','121.1')`;
    const cookie = await login("staff@example.test");
    const draft = { warehouse_id: 1, customer_address_id: 1, is_custom_shipping: false, payment_arrangement: "NET_30", payment_method: "CASH", amount_paid: 0, items: [{ inventory_id: 1, quantity: 1 }] };
    const submit = (cookie: string, orders: object[]) => app.handle(new Request("http://localhost/orders/batch", {
      method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ customer_id: 1, orders }),
    }));
    expect((await submit(cookie, [draft, { ...draft, warehouse_id: 2, items: [{ inventory_id: 2, quantity: 1 }] }])).status).toBe(403);
    expect(await sql`select id from orders`).toHaveLength(2);
    const response = await submit(cookie, [draft, draft]);
    expect(response.status).toBe(200);
    expect((await response.json()).orders).toHaveLength(2);
    const driver = await login("driver1@example.test", true);
    expect((await submit(driver, [draft, draft])).status).toBe(403);
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
    const blocked = await app.handle(request());
    expect(blocked.status).toBe(409);
    expect((await blocked.json()).message).toContain("Submit Proof of Delivery");
    expect(await sql`select * from driver_stop_outcomes`).toHaveLength(0);
    expect((await service.trip(3, run.id)).stops[0].status).toBe("pending");
    await require("./driver-fixture").seedStopProof(sql, run.stopId);
    expect((await app.handle(request())).status).toBe(200);
    expect((await app.handle(request())).status).toBe(200);
    expect(await sql`select * from payments`).toHaveLength(0);
    await sql`update deliveries set driver_id=4 where id=${run.id}`;
    expect((await app.handle(request())).status).toBe(404);
    expect(await sql`select * from audit_logs where action like '%driver/stops%'`).not.toHaveLength(0);
  });
  test("concurrent conflicting outcomes commit exactly one result", async () => {
    const run = await schedule(); await delivery.dispatchDelivery(run.id, 1);
    await require("./driver-fixture").seedStopProof(sql, run.stopId);
    const results = await Promise.allSettled([
      service.outcome(3, run.stopId, { version: 2, operationKey: crypto.randomUUID() }, "delivered"),
      service.outcome(3, run.stopId, { version: 2, operationKey: crypto.randomUUID(), reason: "Unavailable" }, "failed"),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(await sql`select * from driver_stop_outcomes`).toHaveLength(1);
  });
  test("durable actor-scoped receipts resolve ambiguous commits and reject key reuse", async () => {
    const { syncCapabilities } = require("../src/modules/driver/sync-receipts");
    const { SettingService, MOBILE_OFFLINE_WRITES_SETTING: name } = require("../src/modules/settings/service");
    expect(await syncCapabilities()).toMatchObject({ protocol: 1, acceptNewCommands: false });
    await SettingService.updateSetting([{ name, value: "true", version: 1 }]);
    expect(await syncCapabilities()).toMatchObject({ protocol: 1, acceptNewCommands: true });
    const run = await schedule(); await delivery.dispatchDelivery(run.id, 1);
    const key = crypto.randomUUID();
    const command = { version: 2, operationKey: key, reason: "Closed" };
    const results = await Promise.all([
      service.outcome(3, run.stopId, command, "failed"),
      service.outcome(3, run.stopId, command, "failed"),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ previousTripVersion: 2, tripVersion: 3 });
    expect(await sql`select * from driver_sync_receipts where operation_key=${key}`).toHaveLength(1);
    expect(await sql`select * from driver_stop_outcomes`).toHaveLength(1);
    await expect(service.outcome(3, run.stopId, { ...command, reason: "Different" }, "failed")).rejects.toThrow("different details");
    await sql`update deliveries set driver_id=4 where id=${run.id}`;
    const { operationReceipt } = require("../src/modules/driver/sync-receipts");
    await SettingService.updateSetting([{ name, value: "false", version: 2 }]);
    expect(await syncCapabilities()).toMatchObject({ protocol: 1, acceptNewCommands: false });
    expect(await operationReceipt(3, key)).toMatchObject({ accepted: true, result: results[0] });
    expect(await operationReceipt(4, key)).toEqual({ accepted: false, result: null });
    // Current ownership is still enforced on POST; receipt lookup is minimal.
    await expect(service.outcome(3, run.stopId, command, "failed")).rejects.toThrow("Assignment not found");
    expect(mayAccess("driver", "GET", `/driver/sync/operations/${key}`)).toBe(true);
    expect(mayAccess("customer", "GET", `/driver/sync/operations/${key}`)).toBe(false);
  });
  test("offline recording is saved through admin Settings without reseeding and ignores the old environment flag", async () => {
    const { SettingService, MOBILE_OFFLINE_WRITES_SETTING: name } = require("../src/modules/settings/service");
    const { syncCapabilities } = require("../src/modules/driver/sync-receipts");
    const previous = process.env.HYOPS_ENABLE_DRIVER_OFFLINE_WRITES;
    process.env.HYOPS_ENABLE_DRIVER_OFFLINE_WRITES = "true";
    try {
      expect((await SettingService.getAllSettings())[name]).toMatchObject({ value: "false", version: 1 });
      expect(await syncCapabilities()).toMatchObject({ acceptNewCommands: false });
      const admin = await login("admin@example.test"), staff = await login("staff@example.test");
      const driver = await login("driver1@example.test", true);
      const update = (cookie: string, value: string, version = 1) => app.handle(new Request("http://localhost/settings", {
        method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify([{ name, value, version }]),
      }));
      expect((await update(staff, "true")).status).toBe(403);
      expect((await update(driver, "true")).status).toBe(403);
      expect((await update(admin, "TRUE")).status).toBe(400);
      expect(await sql`select * from settings where name=${name}`).toHaveLength(0);
      expect((await update(admin, "true")).status).toBe(200);
      expect((await SettingService.getAllSettings())[name]).toMatchObject({ value: "true", version: 2 });
      const capabilities = await app.handle(new Request("http://localhost/driver/sync/capabilities", { headers: { cookie: driver } }));
      expect(await capabilities.json()).toMatchObject({ protocol: 1, acceptNewCommands: true });
      await expect(SettingService.updateSetting([{ name, value: "false", version: 1 }])).rejects.toThrow("modified");
      expect((await update(admin, "false", 2)).status).toBe(200);
      expect(await syncCapabilities()).toMatchObject({ protocol: 1, acceptNewCommands: false });
    } finally {
      if (previous === undefined) delete process.env.HYOPS_ENABLE_DRIVER_OFFLINE_WRITES;
      else process.env.HYOPS_ENABLE_DRIVER_OFFLINE_WRITES = previous;
    }
  });
});
