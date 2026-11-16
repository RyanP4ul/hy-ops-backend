import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

const testUrl = process.env.HYOPS_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("delivery staff notifications (disposable database)", () => {
  let sql: any;
  let service: typeof import("../src/modules/deliveries/staff-notifications");
  let delivery: typeof import("../src/modules/deliveries/service").DeliveryService;
  beforeAll(async () => {
    require("./live/environment").fixtureEnvironment();
    sql = require("postgres").default(testUrl, { onnotice: () => {} });
    service = require("../src/modules/deliveries/staff-notifications");
    delivery = require("../src/modules/deliveries/service").DeliveryService;
  });
  afterAll(async () => { await sql?.end(); await require("../src/db").db.$client.end({ timeout: 2 }); });
  beforeEach(async () => { await require("./driver-fixture").seedDriverFixture(sql); });
  async function dispatch() {
    const run = await delivery.createDelivery({ order_ids: [1], driver_id: 3, vehicle_id: 1,
      scheduled_date: "2099-01-01", scheduled_time: "10:00", delivery_type: "INTERNAL", delivery_allowance: 0, fuel: 0, toll: 0 }, 1);
    await delivery.dispatchDelivery(run.id, 1);
    return run.id;
  }
  async function expire(id: number) {
    await sql`update deliveries set location_tracking_started_at=now()-interval '3 minutes',
      last_location_received_at=null where id=${id}`;
  }
  test("grace period, missing first fix, scoped recipients and concurrent duplicate prevention", async () => {
    const id = await dispatch();
    await sql`insert into users(email,name,password_hash,role,created_at,updated_at,is_active,is_archived) values
      ('south@example.test','South','fixture','staff',0,0,true,false),
      ('inactive@example.test','Inactive','fixture','admin',0,0,false,false),
      ('archived@example.test','Archived','fixture','admin',0,0,true,true)`;
    await sql`insert into staffs(user_id,warehouse_id) select id,2 from users where email='south@example.test'`;
    await service.checkStoppedDeliveryLocations();
    expect(await sql`select * from notifications`).toHaveLength(0);
    await expire(id);
    await Promise.all([service.checkStoppedDeliveryLocations(), service.checkStoppedDeliveryLocations()]);
    await service.checkStoppedDeliveryLocations();
    expect((await sql`select user_id,type from notifications order by user_id`).map((row: any) => ({ ...row }))).toEqual([
      { user_id: 1, type: "DELIVERY_LOCATION_STOPPED" }, { user_id: 2, type: "DELIVERY_LOCATION_STOPPED" },
    ]);
  });
  test("only the assigned driver's receipt resets an outage; another outage alerts again", async () => {
    const id = await dispatch();
    await expire(id);
    await service.checkStoppedDeliveryLocations();
    await service.receiveDriverLocation(id, 4);
    expect((await sql`select location_alerted_at from deliveries where id=${id}`)[0].location_alerted_at).not.toBeNull();
    await service.receiveDriverLocation(id, 3);
    expect((await sql`select location_alerted_at from deliveries where id=${id}`)[0].location_alerted_at).toBeNull();
    await service.checkStoppedDeliveryLocations();
    expect(await sql`select * from notifications`).toHaveLength(2);
    await sql`update deliveries set last_location_received_at=now()-interval '3 minutes' where id=${id}`;
    await service.checkStoppedDeliveryLocations();
    expect(await sql`select * from notifications`).toHaveLength(4);
    expect((await sql`select location_alert_count from deliveries where id=${id}`)[0].location_alert_count).toBe(2);
  });
  test("GPS alerts stop outside in_transit and completion notifies exactly once", async () => {
    const id = await dispatch();
    await expire(id);
    for (const status of ["scheduled", "cancelled", "returning", "completed"]) {
      await sql`update deliveries set status=${status} where id=${id}`;
      await service.checkStoppedDeliveryLocations();
    }
    expect(await sql`select * from notifications`).toHaveLength(0);
    await sql`update deliveries set status='returning' where id=${id}`;
    await sql`update deliveries_stops set status='delivered' where delivery_id=${id}`;
    await delivery.completeDelivery(id, 1);
    await delivery.completeDelivery(id, 1);
    expect((await sql`select user_id,type from notifications order by user_id`).map((row: any) => ({ ...row }))).toEqual([
      { user_id: 1, type: "DELIVERY_COMPLETED" }, { user_id: 2, type: "DELIVERY_COMPLETED" },
    ]);
    await service.checkStoppedDeliveryLocations();
    expect(await sql`select * from notifications`).toHaveLength(2);
  });
  test("automatic warehouse arrival sends the same completion notification", async () => {
    const id = await dispatch();
    await sql`update deliveries_stops set status='delivered' where delivery_id=${id}`;
    await sql`update deliveries set status='returning',updated_at=now()-interval '1 second' where id=${id}`;
    await sql`insert into vehicle_positions(vehicle_id,latitude,longitude,accuracy_m,recorded_at) values(1,14.5,121,10,now())`;
    await delivery.completeDelivery(id, undefined, undefined, true);
    expect((await sql`select status from deliveries where id=${id}`)[0].status).toBe("completed");
    expect(await sql`select * from notifications where type='DELIVERY_COMPLETED'`).toHaveLength(2);
  });
  test("rolled-back events leave no staff notifications", async () => {
    const id = await dispatch();
    await expect(require("../src/db").db.transaction(async (tx: any) => {
      await service.notifyDeliveryStaff(tx, { id, vehicle_id: 1 }, "Rolled back completion", "Completed", "DELIVERY_COMPLETED");
      throw new Error("rollback fixture");
    })).rejects.toThrow("rollback fixture");
    expect(await sql`select * from notifications`).toHaveLength(0);
  });
});
