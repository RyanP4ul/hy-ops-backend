import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";

const testDatabaseUrl = process.env.HYOPS_TEST_DATABASE_URL;
const describeDb = testDatabaseUrl ? describe : describe.skip;

let sql: ReturnType<typeof postgres>;
let app: ReturnType<typeof import("../src/app").createApp>;
let DeliveryService: typeof import("../src/modules/deliveries/service").DeliveryService;
let CustomerReturnService: typeof import("../src/modules/deliveries/customer-returns").CustomerReturnService;
let ProductService: typeof import("../src/modules/products/service").ProductService;
let InventoryService: typeof import("../src/modules/inventory/service").InventoryService;
let StockTransferService: typeof import("../src/modules/inventory/transfers").StockTransferService;
let OrderService: typeof import("../src/modules/order/service").OrderService;
let WarehouseService: typeof import("../src/modules/warehouse/service").WarehouseService;
let DeliveryScheduleService: typeof import("../src/modules/delivery-schedule/services").DeliveryScheduleService;
let optimizeStopSequence: typeof import("../src/modules/delivery-expenses/osrm").optimizeStopSequence;

async function expectReject(fn: () => Promise<unknown>, match?: RegExp) {
  try {
    await fn();
  } catch (err) {
    if (match) {
      expect(err instanceof Error ? err.message : String(err)).toMatch(match);
    }
    return err;
  }
  throw new Error("Expected promise to reject, but it resolved.");
}

async function seedFixture() {
  await sql`
    truncate table
      stock_transfer_items,
      stock_transfers,
      customer_return_disposition_items,
      customer_returns,
      driver_sync_receipts,
      driver_stop_proofs,
      driver_stop_outcomes,
      deliveries_proof,
      deliveries_expenses,
      deliveries_event,
      deliveries_stops,
      deliveries,
      vehicle_positions,
      payment_group_allocations,
      payment_groups,
      payment_refunds,
      payment_receipts,
      payments,
      order_items,
      orders,
      order_groups,
      stock_movements,
      inventory,
      product_variants,
      products,
      vehicles,
      customer_addresses,
      customers,
      drivers,
      staffs,
      warehouses,
      users,
      settings
    restart identity cascade
  `;

  const now = Math.floor(Date.now() / 1000);
  const hash = await Bun.password.hash("Secret123!", "bcrypt");

  await sql`
    insert into settings (name, value, version, created_at, updated_at)
    values ('low_stock_threshold', '10', 1, ${now}, ${now})
  `;

  await sql`
    insert into warehouses (name, street_address, city, state, zip_code, latitude, longitude, daily_order_limit, operating_days, arrival_radius_m, is_active, is_archived, created_at, updated_at)
    values
      ('Main Hub', '123 EDSA', 'Quezon City', 'Metro Manila', '1100', '14.6500', '121.0500', 5, '[1,2,3,4,5]'::jsonb, 150, true, false, ${now}, ${now}),
      ('South Hub', '456 Alabang', 'Muntinlupa', 'Metro Manila', '1770', '14.4200', '121.0400', 10, '[1,2,3,4,5,6]'::jsonb, null, true, false, ${now}, ${now})
  `;

  await sql`
    insert into users (email, name, password_hash, role, is_active, is_archived, created_at, updated_at)
    values
      ('admin@test.local', 'Admin One', ${hash}, 'admin', true, false, ${now}, ${now}),
      ('staff@test.local', 'Staff One', ${hash}, 'staff', true, false, ${now}, ${now}),
      ('driver1@test.local', 'Driver One', ${hash}, 'driver', true, false, ${now}, ${now}),
      ('driver2@test.local', 'Driver Two', ${hash}, 'driver', true, false, ${now}, ${now}),
      ('customer@test.local', 'Customer One', ${hash}, 'customer', true, false, ${now}, ${now})
  `;

  await sql`insert into staffs (user_id, warehouse_id) values (2, 1)`;
  await sql`
    insert into drivers (user_id, warehouse_id, status, phone_number)
    values
      (3, 1, 'available', '09171111111'),
      (4, 1, 'available', '09172222222')
  `;
  await sql`insert into customers (user_id, company_name, phone_number) values (5, 'Acme Corp', '09173333333')`;
  await sql`
    insert into customer_addresses (customer_id, address_line, barangay, city_municipality, province, postal_code, latitude, longitude)
    values (1, '789 Ayala Ave', 'Bel-Air', 'Makati', 'Metro Manila', '1209', '14.5547', '121.0244')
  `;

  await sql`
    insert into vehicles (warehouse_id, plate_number, status, type, max_weight_kg, is_active, is_archived, created_at, updated_at)
    values
      (1, 'ABC-1001', 'available', 'van', '100.00', true, false, ${now}, ${now}),
      (1, 'XYZ-2002', 'available', 'truck', '2000.00', true, false, ${now}, ${now})
  `;

  await sql`
    insert into products (name, is_active, is_archived)
    values ('Hydraulic Oil', true, false)
  `;
  await sql`
    insert into product_variants (product_id, name, sku, price, cost_price, unit, weight_kg)
    values (1, '20L Drum', 'HYD-20L', '1500.00', '950.00', 'drum', '25.00')
  `;
  await sql`
    insert into inventory (warehouse_id, product_id, product_variant_id, quantity, reserved, reorder_point, is_active, is_archived, created_at, updated_at)
    values (1, 1, 1, 50, 0, 20, true, false, ${now}, ${now})
  `;
}

async function createSchedulingOrder(qty = 2, paymentArrangement: "NET_30" | "PAY_ON_DELIVERY" = "NET_30") {
  const created = await OrderService.createOrder({
    warehouse_id: 1,
    customer_id: 1,
    customer_address_id: 1,
    is_custom_shipping: false,
    payment_arrangement: "NET_30",
    payment_method: "CASH",
    amount_paid: 0,
    items: [{ inventory_id: 1, quantity: qty }],
  });
  await sql`update orders set status = 'SCHEDULING', payment_arrangement = ${paymentArrangement} where id = ${created.id}`;
  return created.id;
}

describeDb("Senior Gap Remediation (Phases 1, 2 & 3)", () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = testDatabaseUrl;
    process.env.JWT_SECRET = "test-jwt-secret-1234567890";
    process.env.JWT_REFRESH_SECRET = "test-refresh-secret-1234567890";
    process.env.HYOPS_ENABLE_INTEGRATIONS = "false";
    process.env.HYOPS_ENABLE_AUTOMATION = "false";

    if (!testDatabaseUrl) throw new Error("Missing HYOPS_TEST_DATABASE_URL");
    sql = postgres(testDatabaseUrl);
    ({ DeliveryService } = require("../src/modules/deliveries/service"));
    ({ CustomerReturnService } = require("../src/modules/deliveries/customer-returns"));
    ({ ProductService } = require("../src/modules/products/service"));
    ({ InventoryService } = require("../src/modules/inventory/service"));
    ({ StockTransferService } = require("../src/modules/inventory/transfers"));
    ({ OrderService } = require("../src/modules/order/service"));
    ({ WarehouseService } = require("../src/modules/warehouse/service"));
    ({ DeliveryScheduleService } = require("../src/modules/delivery-schedule/services"));
    ({ optimizeStopSequence } = require("../src/modules/delivery-expenses/osrm"));
    const { createApp } = require("../src/app");
    app = createApp({ automation: false, externalIntegrations: false });
  });

  beforeEach(async () => {
    await seedFixture();
  });

  afterAll(async () => {
    await sql.end({ timeout: 5 });
  });

  test("P0-1 & P1-3: blocks vehicle double-booking, overlapping time windows, and payload overload", async () => {
    const o1 = await createSchedulingOrder(2); // 50 kg
    const o2 = await createSchedulingOrder(2); // 50 kg
    const oHeavy = await createSchedulingOrder(5); // 125 kg > 100 kg van capacity

    // Overload blocked on 100kg van
    await expectReject(
      () =>
        DeliveryService.createDelivery(
          {
            order_ids: [oHeavy],
            driver_id: 3,
            vehicle_id: 1,
            scheduled_date: "2099-05-01",
            scheduled_time: "08:00",
            delivery_type: "INTERNAL",
            delivery_allowance: 200,
            fuel: 300,
            toll: 50,
          },
          1,
        ),
      /exceeding vehicle ABC-1001 capacity/i,
    );

    // Succeeds on 2000kg truck
    const truckRun = await DeliveryService.createDelivery(
      {
        order_ids: [oHeavy],
        driver_id: 3,
        vehicle_id: 2,
        scheduled_date: "2099-05-01",
        scheduled_time: "08:00",
        delivery_type: "INTERNAL",
        delivery_allowance: 200,
        fuel: 300,
        toll: 50,
        estimated_duration_minutes: 90,
      },
      1,
    );
    expect(truckRun.id).toBeGreaterThan(0);

    // Same vehicle at overlapping time (09:00 within 08:00..10:00) with a DIFFERENT driver -> blocked!
    await expectReject(
      () =>
        DeliveryService.createDelivery(
          {
            order_ids: [o1],
            driver_id: 4,
            vehicle_id: 2,
            scheduled_date: "2099-05-01",
            scheduled_time: "09:00",
            delivery_type: "INTERNAL",
            delivery_allowance: 150,
            fuel: 100,
            toll: 0,
          },
          1,
        ),
      /vehicle already has an overlapping delivery/i,
    );

    // Same driver at overlapping time with a DIFFERENT vehicle -> blocked!
    await expectReject(
      () =>
        DeliveryService.createDelivery(
          {
            order_ids: [o1],
            driver_id: 3,
            vehicle_id: 1,
            scheduled_date: "2099-05-01",
            scheduled_time: "09:30",
            delivery_type: "INTERNAL",
            delivery_allowance: 150,
            fuel: 100,
            toll: 0,
          },
          1,
        ),
      /driver already has an overlapping delivery/i,
    );

    // Non-overlapping later slot (10:30 >= 08:00 + 120m) succeeds
    const afternoonRun = await DeliveryService.createDelivery(
      {
        order_ids: [o1, o2],
        driver_id: 3,
        vehicle_id: 1,
        scheduled_date: "2099-05-01",
        scheduled_time: "10:30",
        delivery_type: "INTERNAL",
        delivery_allowance: 150,
        fuel: 100,
        toll: 0,
      },
      1,
    );
    expect(afternoonRun.id).toBeGreaterThan(0);

    // Batched getDelivery returns both runs with stops, warehouse, and pickups
    const list = await DeliveryService.getDelivery(0, 10, "", undefined, undefined, false, false, 1);
    expect(list.total).toBe(2);
    expect(list.rows[0].warehouse?.name).toBe("Main Hub");
    expect(list.rows.reduce((sum, r) => sum + r.orders.length, 0)).toBe(3);

    // P0-5: createDeliveryProof inserts cleanly without SQL error
    await DeliveryService.createDeliveryProof(truckRun.id, "deliveries_proof/test.webp", 1);
    const proofs = await sql`select * from deliveries_proof where delivery_id = ${truckRun.id}`;
    expect(proofs.length).toBe(1);
  });

  test("P0-2 & P1-1: failed return pickup unblocks trip, can unassign/reassign, then dispose into restock + damaged", async () => {
    const orderId = await createSchedulingOrder(4);
    const run = await DeliveryService.createDelivery(
      {
        order_ids: [orderId],
        driver_id: 3,
        vehicle_id: 2,
        scheduled_date: "2099-06-01",
        scheduled_time: "09:00",
        delivery_type: "INTERNAL",
        delivery_allowance: 200,
        fuel: 300,
        toll: 0,
      },
      1,
    );
    await DeliveryService.dispatchDelivery(run.id, 1);
    const [stop] = await sql`select id from deliveries_stops where delivery_id = ${run.id}`;
    await DeliveryService.markStopDelivered(stop.id, 1);
    await DeliveryService.completeDelivery(run.id, 1, 2);

    const staffActor = { sub: "2", role: "staff" };
    const req = await CustomerReturnService.request(staffActor, stop.id, {
      reason: "Customer reported leaking seal",
      operationKey: randomUUID(),
    });

    // Assign pickup-only run to driver 3 / vehicle 2
    const assigned = await CustomerReturnService.assign(staffActor, req.id, {
      version: 1,
      vehicleId: 2,
      driverId: 3,
      operationKey: randomUUID(),
    });

    // Driver fails the pickup -> unblocks trip to 'returning'!
    const failRes = await CustomerReturnService.fail(3, req.id, {
      version: 2,
      operationKey: randomUUID(),
      reason: "Customer gate locked, no answer",
    });
    expect(failRes.ok).toBe(true);
    const [afterFailRun] = await sql`select status from deliveries where id = ${assigned.deliveryId}`;
    expect(afterFailRun.status).toBe("returning");

    // Staff completes the returning empty run
    await DeliveryService.completeDelivery(assigned.deliveryId, 1, 2);

    // Staff unassigns failed pickup back to 'requested', then reassigns
    const unassigned = await CustomerReturnService.unassign(staffActor, req.id, { version: 3 });
    expect(unassigned.status).toBe("requested");

    const reassigned = await CustomerReturnService.assign(staffActor, req.id, {
      version: 4,
      vehicleId: 2,
      driverId: 3,
      operationKey: randomUUID(),
    });

    // Driver uploads collection proof, collects, staff confirms warehouse receipt
    await expectReject(
      () =>
        CustomerReturnService.collect(3, req.id, {
          version: 5,
          operationKey: randomUUID(),
        }),
      /proof of collection/i,
    );
    const { seedReturnProof } = await import("./driver-fixture.js");
    await seedReturnProof(sql, req.id, 3);
    await CustomerReturnService.collect(3, req.id, {
      version: 5,
      operationKey: randomUUID(),
    });
    await DeliveryService.completeDelivery(reassigned.deliveryId, 1, 2);

    // Inventory before disposition: 50 - 4 = 46
    const [invBefore] = await sql`select quantity from inventory where id = 1`;
    expect(invBefore.quantity).toBe(46);

    // P1-1: Staff inspects and disposes: 3 resellable restocked, 1 damaged write-off
    const disposeKey = randomUUID();
    const disposed = await CustomerReturnService.dispose(staffActor, req.id, {
      version: 7,
      operationKey: disposeKey,
      notes: "3 drums intact, 1 drum punctured",
      items: [{ inventoryId: 1, restockedQty: 3, damagedQty: 1 }],
    });
    expect(disposed.disposition).toBe("partial");

    // Idempotent replay succeeds
    const replay = await CustomerReturnService.dispose(staffActor, req.id, {
      version: 7,
      operationKey: disposeKey,
      notes: "3 drums intact, 1 drum punctured",
      items: [{ inventoryId: 1, restockedQty: 3, damagedQty: 1 }],
    });
    expect(replay.disposition).toBe("partial");

    const [invAfter] = await sql`select quantity from inventory where id = 1`;
    expect(invAfter.quantity).toBe(49); // 46 + 3 restocked
    const movements = await sql`select kind, quantity_delta from stock_movements where kind in ('customer_return_restock', 'customer_return_damaged') order by id`;
    expect([...movements]).toEqual([
      { kind: "customer_return_restock", quantity_delta: 3 },
      { kind: "customer_return_damaged", quantity_delta: 0 },
    ]);
  });

  test("P1-2 & P1-4: COD warehouse return records payment atomically & expense settlement approves actuals", async () => {
    const orderId = await createSchedulingOrder(2, "PAY_ON_DELIVERY"); // 2 * 1500 = 3000 PHP
    const run = await DeliveryService.createDelivery(
      {
        order_ids: [orderId],
        driver_id: 3,
        vehicle_id: 2,
        scheduled_date: "2099-07-01",
        scheduled_time: "09:00",
        delivery_type: "INTERNAL",
        delivery_allowance: 200,
        fuel: 300,
        toll: 50,
      },
      1,
    );
    await DeliveryService.dispatchDelivery(run.id, 1);
    const [stop] = await sql`select id from deliveries_stops where delivery_id = ${run.id}`;
    await DeliveryService.markStopDelivered(stop.id, 1);

    const summary = await DeliveryService.getReturnSummary(run.id, 1);
    expect(summary.codOrders.length).toBe(1);
    expect(summary.codOrders[0].remainingAmount).toBe("3000.00");

    await DeliveryService.completeDelivery(run.id, 1, 2, false, [
      {
        paymentNumber: summary.codOrders[0].paymentNumber,
        amountReceived: 3000,
        version: summary.codOrders[0].paymentVersion,
      },
    ]);

    const [payment] = await sql`select amount, payment_status from payments where order_id = ${orderId}`;
    expect(payment.amount).toBe("3000.00");
    expect(payment.payment_status).toBe("PAID");

    // P1-4: Settle expense with actuals
    const expenses = await DeliveryService.getExpenses(run.id, 1);
    expect(expenses.length).toBe(1);
    const settled = await DeliveryService.settleExpense(
      run.id,
      expenses[0].id,
      {
        status: "approved",
        actual_delivery_allowance: 200,
        actual_fuel: 340,
        actual_toll: 60,
        settlement_notes: "Verified with gas receipt #882",
        version: expenses[0].version,
      },
      2,
      1,
    );
    expect(settled.status).toBe("approved");
    expect(settled.actual_fuel).toBe("340.00");
  });

  test("P0-4, P2-1, P2-2, P2-3, P2-4 & P2-5: global SKU, COGS snapshot, stock transfer, warehouse rules & public tracking", async () => {
    // P0-4: Global SKU uniqueness rejects duplicate SKU on a DIFFERENT product
    await expectReject(
      () =>
        ProductService.createProduct({
          name: "Another Oil Product",
          version: 0,
          variants: [
            {
              name: "Duplicate SKU Variant",
              sku: "HYD-20L",
              price: "1200.00",
              unit: "drum",
              description: null,
              weight_kg: "20.00",
              width_value: null,
              width_unit: null,
              length_value: null,
              length_unit: null,
              cost_price: "800.00",
            },
          ],
        }),
      /already in use/i,
    );

    // P2-1: Order creation snapshots unit_cost_snapshot from product_variants.cost_price
    const orderId = await createSchedulingOrder(2);
    const [item] = await sql`select unit_price_snapshot, unit_cost_snapshot from order_items where order_id = ${orderId}`;
    expect(item.unit_price_snapshot).toBe("1500.00");
    expect(item.unit_cost_snapshot).toBe("950.00");

    // P2-5: Public tracking endpoint works without auth and leaks no customer phone
    const [ord] = await sql`select tracking_token from orders where id = ${orderId}`;
    const trackRes = await app.handle(new Request(`http://localhost/public/track/${ord.tracking_token}`));
    expect(trackRes.status).toBe(200);
    const trackJson = await trackRes.json();
    expect(trackJson.status).toBe("SCHEDULING");
    expect(trackJson.warehouse_name).toBe("Main Hub");
    expect(trackJson.items[0].quantity).toBe(2);
    expect(trackJson.phone).toBeUndefined();

    // P2-2: Per-SKU reorder_point (20) overrides global threshold (10)
    const [invRow] = await sql`select version from inventory where id = 1`;
    await InventoryService.updateInventory(
      1,
      {
        warehouse_id: 1,
        product_variant_id: 1,
        quantity: 18,
        reserved: 2,
        version: invRow.version,
        movement_kind: "cycle_count",
        reason: "Physical count adjustment",
      },
      2,
    );
    // Available = 16, which is > global 10, but <= per-SKU reorder_point 20!
    const suggestions = await InventoryService.getReorderSuggestions(1);
    expect(suggestions.rows.length).toBe(1);

    // P2-2: Inter-warehouse stock transfer (Warehouse 1 -> Warehouse 2)
    const transfer = await StockTransferService.create(
      {
        from_warehouse_id: 1,
        to_warehouse_id: 2,
        notes: "Rebalance south hub",
        items: [{ product_variant_id: 1, quantity: 5 }],
      },
      2,
      1,
    );
    await StockTransferService.dispatch(transfer.id, 1, 2, 1);
    const [srcAfterDispatch] = await sql`select quantity from inventory where warehouse_id = 1 and product_variant_id = 1`;
    expect(srcAfterDispatch.quantity).toBe(13); // 18 - 5

    await StockTransferService.receive(transfer.id, 2, 1, undefined);
    const [dstAfterReceive] = await sql`select quantity from inventory where warehouse_id = 2 and product_variant_id = 1`;
    expect(dstAfterReceive.quantity).toBe(5);

    // P2-4: Warehouse overview + operating days (Main Hub operates Mon-Fri, daily_order_limit = 5)
    const overview = await WarehouseService.getWarehouseOverview(1);
    expect(overview.vehicles.total).toBe(2);
    expect(overview.drivers.total).toBe(2);
    expect(overview.staff_count).toBe(1);

    const availDates = await DeliveryScheduleService.getAvailableOrderDates({
      maxOrdersPerDay: 99,
      daysAhead: 14,
      warehouse_id: 1,
    });
    expect(availDates.every((d) => d.available_slots <= 5)).toBe(true);
    expect(availDates.every((d) => {
      const dow = new Date(`${d.date}T00:00:00Z`).getUTCDay();
      return dow >= 1 && dow <= 5;
    })).toBe(true);

    // P2-3: Route optimization orders closer stop first
    const opt = await optimizeStopSequence(
      { latitude: 14.65, longitude: 121.05 },
      [
        { orderId: 101, latitude: 14.3, longitude: 121.05 }, // farther
        { orderId: 102, latitude: 14.62, longitude: 121.05 }, // closer
      ],
    );
    expect(opt.optimizedOrderIds.length).toBe(2);
    expect(opt.optimizedOrderIds[0]).toBe(102);
  });

  test("Part 1: Dashboard warehouse scoping, automation notification fixes, and Fleet Map speed=0", async () => {
    const { DashboardService } = await import("../src/modules/dashboard/services.js");
    const { checkLowStock, checkOverduePayments, createNotifications, findOverduePayments } =
      await import("../src/manager/automation-tasks.js");
    const { buildFleetOverview } = await import("../src/modules/fleet-map/fleet.mapper.js");

    // Seed a second staff user for warehouse 2 and a pending order in warehouse 2
    const hash = await Bun.password.hash("password123", { algorithm: "bcrypt", cost: 4 });
    const [wh2Staff] = await sql`
      insert into users(email, name, password_hash, role, created_at, updated_at)
      values ('staff2@hyops.test', 'Staff 2', ${hash}, 'staff', 0, 0)
      returning id
    `;
    await sql`insert into staffs(user_id, warehouse_id) values (${wh2Staff.id}, 2)`;
    await sql`
      insert into inventory(warehouse_id, product_id, product_variant_id, quantity, reserved, reorder_point, created_at, updated_at)
      values (2, 1, 1, 3, 0, 5, 0, 0)
    `;
    await sql`
      insert into orders(order_number, warehouse_id, customer_id, status, stock_reserved, delivery_method, payment_arrangement, shipping_address, shipping_latitude, shipping_longitude)
      values ('ORD-WH2-PEND', 2, 1, 'PENDING', true, 'INTERNAL', 'NET_30', 'South Branch', 14.4, 121.0)
    `;

    // Dashboard exceptions & totals scoped to warehouse 1 must NOT include WH2 pending order
    const wh1Ex = await DashboardService.getExceptions(1);
    const wh2Ex = await DashboardService.getExceptions(2);
    const allEx = await DashboardService.getExceptions(undefined);
    expect(wh1Ex.pendingOrders).toBe(0);
    expect(wh2Ex.pendingOrders).toBe(1);
    expect(allEx.pendingOrders).toBe(1);

    // Automation Bug #2: Low-stock checker honors per-SKU reorder_point and scopes notifications by warehouse
    await checkLowStock();
    const wh1StaffNotifs = await sql`select title from notifications where user_id = 2 and type = 'LOW_STOCK'`;
    const wh2StaffNotifs = await sql`select title from notifications where user_id = ${wh2Staff.id} and type = 'LOW_STOCK'`;
    const adminNotifs = await sql`select title from notifications where user_id = 1 and type = 'LOW_STOCK'`;
    expect(wh1StaffNotifs.length).toBe(0); // WH1 has 50 qty > 20 reorder_point
    expect(wh2StaffNotifs.length).toBe(1); // WH2 has 3 qty <= 5 reorder_point
    expect(adminNotifs.length).toBe(1);

    // Automation Bug #1: Marking a notification read allows a new unread alert when message changes
    await sql`update notifications set is_read = true where user_id = ${wh2Staff.id}`;
    const inserted = await createNotifications(
      [wh2Staff.id],
      wh2StaffNotifs[0].title,
      "2 available (2 on hand, 0 reserved; reorder point: 5).",
      "LOW_STOCK",
    );
    expect(inserted).toBe(1);

    // Automation Bug #3: Completed PAY_ON_DELIVERY order unpaid past 24h is detected as overdue
    const codOrderId = await createSchedulingOrder(1, "PAY_ON_DELIVERY");
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await sql`update orders set status = 'COMPLETED', updated_at = ${oldTime} where id = ${codOrderId}`;
    const overdue = await findOverduePayments();
    expect(overdue.some((r: { orderId: number }) => r.orderId === codOrderId)).toBe(true);
    await checkOverduePayments();
    const [payStatus] = await sql`select payment_status from payments where order_id = ${codOrderId}`;
    expect(payStatus.payment_status).toBe("OVERDUE");

    // Fleet Map speed fallback is 0, not simulated 35
    const overview = buildFleetOverview({
      warehouses: [],
      vehicles: [
        {
          id: 1,
          warehouse_id: 1,
          plate_number: "HYO-001",
          status: "on_delivery",
          type: "truck",
          max_weight_kg: "1000.00",
          max_volume_cbm: null,
          current_odometer_km: 0,
          next_service_odometer_km: null,
          is_archived: false,
          archived_at: null,
          is_active: true,
          version: 1,
          created_at: 0,
          updated_at: 0,
        },
      ],
      deliveries: [],
      stops: [],
      items: [],
      payments: [],
    });
    expect(overview.vehicles[0].speed).toBe(0);
  });

  test("Part 2-D: Vehicle maintenance & odometer log + driver issue report + return pickup proof upload", async () => {
    const { vehicleService } = await import("../src/modules/vehicles/service.js");
    const { ProofService } = await import("../src/modules/driver/proofs.js");
    const sharp = (await import("sharp")).default;

    // Create maintenance log -> puts vehicle 1 into 'maintenance' & updates odometer
    const created = await vehicleService.createMaintenanceLog(
      1,
      2,
      {
        maintenance_type: "preventive",
        title: "45,000 km PMS",
        workshop_name: "HYOps Depot Shop",
        odometer_km: 45200,
        estimated_cost: 4500,
        put_in_maintenance: true,
      },
      1,
    );
    expect(created.vehicle_status).toBe("maintenance");
    expect(created.current_odometer_km).toBe(45200);

    // Complete maintenance log -> restores vehicle 1 to 'available' and sets next PMS
    const finished = await vehicleService.updateMaintenanceLog(
      1,
      created.log.id,
      2,
      {
        version: 1,
        status: "completed",
        actual_cost: 4250,
        next_service_odometer_km: 50000,
        restore_to_available: true,
      },
      1,
    );
    expect(finished.vehicle_status).toBe("available");

    // Schedule & dispatch a delivery so driver 3 can report a vehicle issue and upload a return pickup proof
    const orderId = await createSchedulingOrder(2);
    const run = await DeliveryService.createDelivery(
      {
        order_ids: [orderId],
        driver_id: 3,
        vehicle_id: 1,
        scheduled_date: "2099-09-01",
        scheduled_time: "09:00",
        delivery_type: "INTERNAL",
        delivery_allowance: 200,
        fuel: 300,
        toll: 0,
      },
      1,
    );
    await DeliveryService.dispatchDelivery(run.id, 1);

    const reported = await vehicleService.reportDriverVehicleIssue(3, {
      delivery_id: run.id,
      maintenance_type: "tire_battery",
      title: "Rear left tire slow leak",
      odometer_km: 45350,
    });
    expect(reported.vehicle_id).toBe(1);
    const maintSummary = await vehicleService.getMaintenanceLogs(1, 1);
    expect(maintSummary.summary.open_count).toBe(1);
    expect(maintSummary.vehicle.current_odometer_km).toBe(45350);

    // Complete outbound stop -> request & assign return pickup -> upload photo proof via ProofService
    const [stop] = await sql`select id from deliveries_stops where delivery_id = ${run.id}`;
    await DeliveryService.markStopDelivered(stop.id, 1);
    const req = await CustomerReturnService.request({ sub: "2", role: "staff" }, stop.id, {
      reason: "Wrong variant delivered",
      operationKey: randomUUID(),
    });
    await CustomerReturnService.assign({ sub: "2", role: "staff" }, req.id, {
      version: 1,
      vehicleId: 1,
      driverId: 3,
      operationKey: randomUUID(),
    });

    const memoryStore = new Map<string, Uint8Array>();
    const proofs = new ProofService({
      put: async (key, data) => { memoryStore.set(key, data); },
      get: async (key) => {
        const hit = memoryStore.get(key);
        if (!hit) throw new Error("Missing");
        return hit;
      },
      delete: async (key) => { memoryStore.delete(key); },
    });

    const pngBuffer = await sharp({
      create: { width: 16, height: 16, channels: 3, background: { r: 20, g: 120, b: 220 } },
    })
      .png()
      .toBuffer();
    const file = new File([new Uint8Array(pngBuffer)], "pickup.png", { type: "image/png" });
    await proofs.uploadReturnProof(3, req.id, file, "photo", randomUUID());

    const listed = await proofs.listReturnProofs({ sub: "2", role: "staff" }, req.id);
    expect(listed.length).toBe(1);

    // Collection now succeeds with uploaded proof
    const collected = await CustomerReturnService.collect(3, req.id, {
      version: 2,
      operationKey: randomUUID(),
    });
    expect(collected.ok).toBe(true);
  });
});
