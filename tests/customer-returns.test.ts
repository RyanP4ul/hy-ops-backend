import { beforeAll, beforeEach, afterAll, expect, test, describe } from "bun:test";

const testUrl = process.env.HYOPS_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("customer return retrieval", () => {
  let sql: any, returns: typeof import("../src/modules/deliveries/customer-returns").CustomerReturnService;
  let delivery: typeof import("../src/modules/deliveries/service").DeliveryService;
  let driver: typeof import("../src/modules/driver/service").DriverService;
  const staff = { sub: "2", role: "staff" } as const;
  beforeAll(() => {
    if (!testUrl) throw new Error("Disposable fixture required");
    const url = new URL(testUrl);
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/hyops_test") throw new Error("Disposable fixture required");
    require("./live/environment").fixtureEnvironment();
    process.env.DATABASE_URL = testUrl;
    sql = require("postgres").default(testUrl, { onnotice: () => {} });
    returns = require("../src/modules/deliveries/customer-returns").CustomerReturnService;
    delivery = require("../src/modules/deliveries/service").DeliveryService;
    driver = require("../src/modules/driver/service").DriverService;
  });
  beforeEach(async () => { await require("./driver-fixture").seedDriverFixture(sql); });
  afterAll(async () => { await sql?.end(); await require("../src/db").db.$client.end({ timeout: 2 }); });
  async function rejects(promise: Promise<unknown>, message?: string) {
    let caught: unknown;
    try { await promise; } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error);
    if (message) expect((caught as Error).message).toContain(message);
  }
  async function delivered() {
    const run = await delivery.createDelivery({ order_ids: [1], driver_id: 3, vehicle_id: 1, scheduled_date: "2099-01-01", scheduled_time: "10:00", delivery_type: "INTERNAL", delivery_allowance: 0, fuel: 0, toll: 0 }, 1);
    const [stop] = await sql`select id from deliveries_stops where delivery_id=${run.id}`;
    await rejects(returns.request(staff, stop.id, { reason: "Return", operationKey: crypto.randomUUID() }), "already delivered");
    await delivery.dispatchDelivery(run.id, 1);
    await require("./driver-fixture").seedStopProof(sql, stop.id);
    await driver.outcome(3, stop.id, { version: 2, operationKey: crypto.randomUUID() }, "delivered");
    return { run: run.id, stop: stop.id };
  }
  async function balances() {
    return { inventory: await sql`select quantity,reserved from inventory order by id`, payments: await sql`select * from payments order by id`, refunds: await sql`select * from payment_refunds order by id` };
  }
  test("GPS reads the configured return distance on every update and validates settings", async () => {
    const { recordPosition } = require("../src/modules/fleet-map/fleet.service");
    const { SettingService } = require("../src/modules/settings/service");
    const name = "returning_automatic_confirm_ms_interval";
    expect((await SettingService.getAllSettings())[name]).toMatchObject({ value: "100", version: 1 });
    for (const value of ["0", "30000", "100.5", "invalid"]) {
      await rejects(SettingService.updateSetting([{ name, value, version: 1 }]), "50 to 1000 metres");
    }
    const original = await delivered();
    await recordPosition(1, { latitude: 14.5013, longitude: 121, accuracyM: 5 });
    expect((await sql`select status from deliveries where id=${original.run}`)[0].status).toBe("returning");
    await SettingService.updateSetting([{ name, value: "200", version: 1 }]);
    expect((await SettingService.getAllSettings())[name]).toMatchObject({ value: "200", version: 2 });
    await rejects(SettingService.updateSetting([{ name, value: "150", version: 1 }]), "modified");
    // A corrupt legacy value must not silently expand the radius or complete the run.
    await sql`update settings set value='30000' where name=${name}`;
    await recordPosition(1, { latitude: 14.5013, longitude: 121, accuracyM: 5, recordedAt: new Date(Date.now() + 10).toISOString() });
    expect((await sql`select status from deliveries where id=${original.run}`)[0].status).toBe("returning");
    await SettingService.updateSetting([{ name, value: "200", version: 2 }]);
    await recordPosition(1, { latitude: 14.5013, longitude: 121, accuracyM: 5, recordedAt: new Date(Date.now() + 20).toISOString() });
    expect((await sql`select status from deliveries where id=${original.run}`)[0].status).toBe("completed");
  });
  test("GPS and mobile web settings save together without reseeding and reject invalid intervals", async () => {
    const { SettingService } = require("../src/modules/settings/service");
    const mobile = "mobile_automatic_refresh_interval_ms";
    const arrival = "returning_automatic_confirm_ms_interval";
    expect((await SettingService.getAllSettings())[mobile]).toMatchObject({ value: "30000", version: 1 });
    for (const value of ["0", "-1", "1.5", "NaN", "2147483648"]) {
      await rejects(SettingService.updateSetting([
        { name: arrival, value: "150", version: 1 },
        { name: mobile, value, version: 1 },
      ]), "milliseconds");
    }
    expect(await sql`select * from settings where name in (${mobile}, ${arrival})`).toHaveLength(0);
    await SettingService.updateSetting([
      { name: arrival, value: "150", version: 1 },
      { name: mobile, value: "15000", version: 1 },
    ]);
    const all = await SettingService.getAllSettings();
    expect(all[mobile]).toMatchObject({ value: "15000", version: 2 });
    expect(all[arrival]).toMatchObject({ value: "150", version: 2 });
    expect((await SettingService.getSettingByNames([mobile]))[0].value).toBe("15000");
    await rejects(SettingService.updateSetting([{ name: mobile, value: "60000", version: 1 }]), "modified");
    expect((await SettingService.getAllSettings())[mobile].value).toBe("15000");
  });
  test("GPS auto-confirms only a returning run at its assigned warehouse", async () => {
    const { recordPosition } = require("../src/modules/fleet-map/fleet.service");
    const original = await delivered();
    const before = await balances();
    // Other warehouse, missing accuracy, and stale fixes must not complete the run.
    await recordPosition(1, { latitude: 14.5, longitude: 121, accuracyM: 5, recordedAt: new Date(Date.now() - 120_000).toISOString() });
    await recordPosition(1, { latitude: 14.6, longitude: 121.1, accuracyM: 5 });
    await recordPosition(1, { latitude: 14.5, longitude: 121, recordedAt: new Date(Date.now() + 1).toISOString() });
    expect((await sql`select status from deliveries where id=${original.run}`)[0].status).toBe("returning");
    const recordedAt = new Date(Date.now() + 10).toISOString();
    await Promise.all([
      recordPosition(1, { latitude: 14.5, longitude: 121, accuracyM: 5, recordedAt }),
      recordPosition(1, { latitude: 14.5, longitude: 121, accuracyM: 5, recordedAt }),
    ]);
    expect((await sql`select status from deliveries where id=${original.run}`)[0].status).toBe("completed");
    expect((await sql`select status from vehicles where id=1`)[0].status).toBe("available");
    expect((await sql`select status from drivers where user_id=3`)[0].status).toBe("available");
    expect(await balances()).toEqual(before);
  });
  test("GPS does not complete pending pickups; collected returns are received without restocking", async () => {
    const { recordPosition } = require("../src/modules/fleet-map/fleet.service");
    const original = await delivered();
    const task = await returns.request(staff, original.stop, { reason: "Return", operationKey: crypto.randomUUID() });
    await returns.assign(staff, task.id, { version: 1, vehicleId: 1, driverId: 3, operationKey: crypto.randomUUID() });
    await recordPosition(1, { latitude: 14.5, longitude: 121, accuracyM: 5 });
    expect((await sql`select status from deliveries where id=${original.run}`)[0].status).toBe("in_transit");
    await returns.collect(3, task.id, { version: 2, operationKey: crypto.randomUUID() });
    const before = await balances();
    await recordPosition(1, { latitude: 14.5, longitude: 121, accuracyM: 5, recordedAt: new Date(Date.now() + 10).toISOString() });
    expect((await sql`select status,received_by from customer_returns where id=${task.id}`)[0]).toEqual({ status: "received", received_by: null });
    expect((await sql`select status from deliveries where id=${original.run}`)[0].status).toBe("completed");
    expect(await balances()).toEqual(before);
  });
  test("GPS arrival leaves failed goods for manual warehouse inspection", async () => {
    const { recordPosition } = require("../src/modules/fleet-map/fleet.service");
    const run = await delivery.createDelivery({ order_ids: [1], driver_id: 3, vehicle_id: 1, scheduled_date: "2099-01-01", scheduled_time: "10:00", delivery_type: "INTERNAL", delivery_allowance: 0, fuel: 0, toll: 0 }, 1);
    await delivery.dispatchDelivery(run.id, 1);
    const [stop] = await sql`select id from deliveries_stops where delivery_id=${run.id}`;
    await driver.outcome(3, stop.id, { version: 2, operationKey: crypto.randomUUID(), reason: "Closed" }, "failed");
    const before = await balances();
    await recordPosition(1, { latitude: 14.5, longitude: 121, accuracyM: 5, recordedAt: new Date(Date.now() + 10).toISOString() });
    expect((await sql`select status from deliveries where id=${run.id}`)[0].status).toBe("returning");
    expect(await balances()).toEqual(before);
    await delivery.completeDelivery(run.id, 1, 2);
    expect((await sql`select status from deliveries where id=${run.id}`)[0].status).toBe("completed");
  });
  test("pickup-only lifecycle is scoped, idempotent and leaves money and stock untouched", async () => {
    const original = await delivered();
    await delivery.completeDelivery(original.run, 1, 2);
    const before = await balances();
    const input = { reason: "Customer requested retrieval", operationKey: crypto.randomUUID() };
    const [first, duplicate] = await Promise.all([returns.request(staff, original.stop, input), returns.request(staff, original.stop, input)]);
    expect(first.id).toBe(duplicate.id);
    expect(await returns.list(staff)).toHaveLength(1);
    await rejects(returns.candidates({ sub: "4", role: "staff" }, first.id), );
    const choices = await returns.candidates(staff, first.id);
    expect(choices.vehicles.map(item => item.id)).toEqual([1]);
    expect(choices.vehicles[0].distanceKm).toBeNull();
    const assignment = { version: 1, vehicleId: 1, driverId: 3, operationKey: crypto.randomUUID() };
    await rejects(returns.assign(staff, first.id, { ...assignment, vehicleId: 2, driverId: 4 }), "warehouse");
    await rejects(returns.assign(staff, first.id, { ...assignment, version: 99 }), "changed");
    const assigned = await returns.assign(staff, first.id, assignment);
    expect(assigned.deliveryId).not.toBe(original.run);
    expect(await returns.assign(staff, first.id, assignment)).toEqual(assigned);
    const trip = await driver.trip(3, assigned.deliveryId);
    expect(trip.status).toBe("in_transit"); expect(trip.stops).toHaveLength(0); expect(trip.pickups).toHaveLength(1);
    expect(trip.pickups[0].items[0].qty).toBe(2);
    await rejects(delivery.completeDelivery(assigned.deliveryId, 1, 2), );
    const command = { version: 2, operationKey: crypto.randomUUID() };
    await rejects(returns.collect(4, first.id, command), "not found");
    await rejects(returns.collect(3, first.id, { ...command, version: 1 }), "changed");
    await returns.collect(3, first.id, command);
    await returns.collect(3, first.id, command);
    expect((await driver.trip(3, assigned.deliveryId)).status).toBe("returning");
    await delivery.completeDelivery(assigned.deliveryId, 1, 2);
    await delivery.completeDelivery(assigned.deliveryId, 1, 2);
    await returns.collect(3, first.id, command);
    await rejects(returns.collect(4, first.id, command), "not found");
    expect(await returns.list(staff)).toHaveLength(0);
    const [received] = await sql`select status,received_by from customer_returns`;
    expect(received).toEqual({ status: "received", received_by: 2 });
    expect(await balances()).toEqual(before);
    expect((await sql`select status from orders where id=1`)[0].status).toBe("COMPLETED");
  });
  test("active vehicle pickup reuses its run and prevents early completion", async () => {
    const original = await delivered();
    const task = await returns.request(staff, original.stop, { reason: "Wrong goods", operationKey: crypto.randomUUID() });
    const before = await balances();
    const choice = await returns.candidates(staff, task.id);
    expect(choice.vehicles[0].driverId).toBe(3);
    const assigned = await returns.assign(staff, task.id, { version: 1, vehicleId: 1, driverId: 3, operationKey: crypto.randomUUID() });
    expect(assigned.deliveryId).toBe(original.run);
    expect((await driver.trip(3, original.run)).status).toBe("in_transit");
    await rejects(delivery.completeDelivery(original.run, 1, 2), );
    await returns.collect(3, task.id, { version: 2, operationKey: crypto.randomUUID() });
    await delivery.completeDelivery(original.run, 1, 2);
    expect(await balances()).toEqual(before);
  });
  test("mixed outbound and pickup work stays active until both are finished", async () => {
    const original = await delivered();
    await delivery.completeDelivery(original.run, 1, 2);
    const task = await returns.request(staff, original.stop, { reason: "Return", operationKey: crypto.randomUUID() });
    await sql`insert into orders(order_number,warehouse_id,customer_id,status,stock_reserved,payment_arrangement,shipping_address,shipping_latitude,shipping_longitude) values('ORDER-3',1,1,'SCHEDULING',true,'FULLY_PAID','Next address',14.56,121.06)`;
    await sql`insert into order_items(order_id,inventory_id,quantity,unit_price_snapshot,price_source) values(3,1,1,12.34,'fixture')`;
    await sql`update inventory set reserved=reserved+1 where id=1`;
    const outbound = await delivery.createDelivery({ order_ids: [3], driver_id: 3, vehicle_id: 1, scheduled_date: "2099-01-02", scheduled_time: "10:00", delivery_type: "INTERNAL", delivery_allowance: 0, fuel: 0, toll: 0 }, 1);
    await delivery.dispatchDelivery(outbound.id, 1);
    await returns.assign(staff, task.id, { version: 1, vehicleId: 1, driverId: 3, operationKey: crypto.randomUUID() });
    const trip = await driver.trip(3, outbound.id);
    await require("./driver-fixture").seedStopProof(sql, trip.stops[0].id);
    await driver.outcome(3, trip.stops[0].id, { version: trip.version, operationKey: crypto.randomUUID() }, "delivered");
    expect((await driver.trip(3, outbound.id)).status).toBe("in_transit");
    await returns.collect(3, task.id, { version: 2, operationKey: crypto.randomUUID() });
    expect((await driver.trip(3, outbound.id)).status).toBe("returning");
    await delivery.completeDelivery(outbound.id, 1, 2);
  });
  test("candidate distance uses fresh GPS and hides stale distance", async () => {
    const original = await delivered();
    const task = await returns.request(staff, original.stop, { reason: "Return", operationKey: crypto.randomUUID() });
    await sql`insert into vehicle_positions(vehicle_id,latitude,longitude,recorded_at) values(1,14.55,121.05,now())`;
    expect((await returns.candidates(staff, task.id)).vehicles[0].distanceKm).toBeCloseTo(0, 4);
    await sql`update vehicle_positions set recorded_at=now()-interval '5 minutes' where vehicle_id=1`;
    expect((await returns.candidates(staff, task.id)).vehicles[0].distanceKm).toBeNull();
    await sql`update customer_returns set latitude=null,longitude=null where id=${task.id}`;
    expect((await returns.list(staff))[0].coordinates).toBeNull();
  });
  test("refund action requires confirmation and driver sessions cannot invoke staff commands", async () => {
    const original = await delivered();
    const app = require("../src/app").createApp({ automation: false, externalIntegrations: false });
    async function login(email: string) {
      const response = await app.handle(new Request("http://localhost/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "fixture-password", is_mobile: email.startsWith("driver") }) }));
      expect(response.status).toBe(200);
      const data = await response.json(); return `access_token=${data.access_token}; refresh_token=${data.refresh_token}`;
    }
    const cookie = await login("staff@example.test");
    const post = (cookie: string, confirmed?: boolean) => app.handle(new Request(`http://localhost/deliveries/stops/${original.stop}/refunded`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ reason: "Return", operationKey: crypto.randomUUID(), ...(confirmed === undefined ? {} : { confirmed }) }) }));
    expect((await post(cookie)).status).toBe(400);
    expect((await post(cookie, false)).status).toBe(400);
    expect(await returns.list(staff)).toHaveLength(0);
    expect((await post(await login("driver1@example.test"), true)).status).toBe(403);
    expect((await post(cookie, true)).status).toBe(200);
  });

});
