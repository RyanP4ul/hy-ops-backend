import { Elysia } from "elysia";
import { authorizeSession } from "../src/modules/auth/policy";
import { beforeAll, describe, expect, test } from "bun:test";

const testUrl = process.env.HYOPS_TEST_DATABASE_URL;
let authApp: import("elysia").AnyElysia;
let reconciliation: typeof import("../src/modules/inventory/reconciliation");
let ProductService: typeof import("../src/modules/products/service").ProductService;
let sql: import("postgres").Sql;
let OrderService: typeof import("../src/modules/order/service").OrderService;
let PaymentService: typeof import("../src/modules/payments/service").PaymentService;
let InvoiceService: typeof import("../src/modules/invoice/service").InvoiceService;
let UserService: typeof import("../src/modules/user/service").UserService;
let InventoryService: typeof import("../src/modules/inventory/service").InventoryService;
let DeliveryScheduleService: typeof import("../src/modules/delivery-schedule/services").DeliveryScheduleService;
let DeliveryService: typeof import("../src/modules/deliveries/service").DeliveryService;
let ArchiveService: typeof import("../src/modules/archives/service").ArchiveService;
let DashboardService: typeof import("../src/modules/dashboard/services").DashboardService;

describe.skipIf(!testUrl)("disposable PostgreSQL transactions", () => {
  beforeAll(async () => {
    const url = new URL(testUrl ?? "");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.pathname !== "/hyops_test") {
      throw new Error("Integration tests require a loopback database named hyops_test.");
    }
    // Override before requiring any application module; never use DATABASE_URL
    // inherited from .env for these tests.
    process.env.DATABASE_URL = testUrl;
    process.env.JWT_SECRET = "hyops-fixture-access-signing-key-not-for-deployment";
    process.env.REFRESH_TOKEN_SECRET = "hyops-fixture-refresh-signing-key-not-for-deployment";
    sql = require("postgres").default(testUrl, { onnotice: () => {} });
    const [identity] = await sql`select current_database() as name`;
    if (identity.name !== "hyops_test") throw new Error("Unexpected test database.");
    ({ OrderService } = require("../src/modules/order/service"));
    ({ PaymentService } = require("../src/modules/payments/service"));
    ({ InvoiceService } = require("../src/modules/invoice/service"));
    ({ UserService } = require("../src/modules/user/service"));
    ({ InventoryService } = require("../src/modules/inventory/service"));
    ({ DeliveryService } = require("../src/modules/deliveries/service"));
    ({ DeliveryScheduleService } = require("../src/modules/delivery-schedule/services"));
    ({ ArchiveService } = require("../src/modules/archives/service"));
    ({ DashboardService } = require("../src/modules/dashboard/services"));
    ({ ProductService } = require("../src/modules/products/service"));
    reconciliation = require("../src/modules/inventory/reconciliation");
    const { authRoutes }: typeof import("../src/modules/auth") = require("../src/modules/auth");
    const { authPlugin }: typeof import("../src/plugins/auth") = require("../src/plugins/auth");
    authApp = new Elysia().use(authPlugin).use(authRoutes).guard({ beforeHandle: async ({ request, cookie: { access_token }, jwt, set }) => {
      const status = await authorizeSession(access_token.value, (token) => jwt.verify(token), UserService.getMutationActor, request.method, new URL(request.url).pathname);
      if (status !== 200) { set.status = status; return { message: "Denied" }; }
    } }, (app) => app.get("/inventory", () => ({ ok: true })).get("/payments", () => ({ ok: true })).get("/users", () => ({ ok: true })));
  });

  async function seed() {
    await sql`truncate users, warehouses, products, inventory, settings restart identity cascade`;
    await sql`insert into users (email,name,password_hash,role,created_at,updated_at) values
      ('a@example.test','Admin A','fixture','admin',0,0),
      ('b@example.test','Admin B','fixture','admin',0,0),
      ('c@example.test','Customer','fixture','customer',0,0)`;
    await sql`insert into warehouses (name,street_address,city,state,zip_code,created_at,updated_at)
      values ('Fixture','Street','City','Province','0000',0,0)`;
    await sql`insert into products (name) values ('Fixture product')`;
    await sql`insert into customers (user_id,company_name,phone_number) values (3,'Fixture customer','09000000000')`;
    await sql`insert into customer_addresses (customer_id,address_line,barangay,city_municipality,province,latitude,longitude) values (1,'123 Test St','Test Barangay','Test City','Test Province','14.5','121.1')`;
    await sql`insert into settings (name,value,created_at,updated_at) values ('customer_order_limit','5',0,0)`;
    await sql`insert into product_variants (product_id,name,sku,price,unit) values (1,'Fixture variant','FIXTURE',12.34,'piece')`;
  }

  test("concurrent admins cannot deactivate each other and leave no admin", async () => {
    await seed();
    const outcomes = await Promise.allSettled([
      UserService.archiveUser(1, 2, 1, { id: 1, tokenVersion: 0 }),
      UserService.archiveUser(2, 1, 1, { id: 2, tokenVersion: 0 }),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [result] = await sql`select count(*)::int as count from users where role='admin' and not is_archived`;
    expect(result.count).toBe(1);
    expect(await sql`select * from archives`).toHaveLength(1);
    expect(await sql`select * from audit_logs where action='USER_DEACTIVATED'`).toHaveLength(1);
  });

  test("failed archive insert rolls back deactivation and token revocation", async () => {
    await seed();
    await sql`alter table archives add constraint fixture_reject check (entity_type <> 'users')`;
    try {
      await expect(UserService.archiveUser(1, 3, 1, { id: 1, tokenVersion: 0 })).rejects.toThrow();
      const [user] = await sql`select is_archived, version, token_version from users where id=3`;
      expect(user).toMatchObject({ is_archived: false, version: 1, token_version: 0 });
      expect(await sql`select * from archives`).toHaveLength(0);
    } finally {
      await sql`alter table archives drop constraint fixture_reject`;
    }
  });

  test("stale user edits cannot overwrite a committed edit", async () => {
    await seed();
    const data = { name: "Renamed", email: "b@example.test", role: "admin" as const };
    await UserService.updateUser(2, 1, data, { id: 1, tokenVersion: 0 });
    await expect(UserService.updateUser(2, 1, { ...data, name: "Stale" }, { id: 1, tokenVersion: 0 })).rejects.toThrow("Version mismatch");
    const [user] = await sql`select name, version from users where id=2`;
    expect(user).toMatchObject({ name: "Renamed", version: 2 });
  });

  test("permanent deletion cannot cascade through history", async () => {
    await seed();
    await expect(UserService.deleteUser(3, 1)).rejects.toThrow("Permanent deletion is disabled");
    expect(await sql`select id from users where id=3`).toHaveLength(1);
  });

  test("concurrent inventory creation yields exactly one correctly linked row", async () => {
    await seed();
    const data = { warehouse_id: 1, product_variant_id: 1, quantity: 10 };
    const results = await Promise.allSettled([InventoryService.createInventory(data), InventoryService.createInventory(data)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rows = await sql`select product_id,quantity from inventory`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ product_id: 1, quantity: 10 });
  });

  test("inventory cannot be reduced below reservations or moved to another variant", async () => {
    await seed();
    const [item] = await InventoryService.createInventory({ warehouse_id: 1, product_variant_id: 1, quantity: 10 });
    await sql`update inventory set reserved=4 where id=${item.id}`;
    const data = { warehouse_id: 1, product_variant_id: 1, quantity: 3, reserved: 4, version: item.version };
    await expect(InventoryService.updateInventory(item.id, data)).rejects.toThrow("less than reserved");
    await expect(InventoryService.updateInventory(item.id, { ...data, quantity: 10, product_variant_id: 2 })).rejects.toThrow("cannot be changed");
    await expect(InventoryService.deleteInventory(item.id, item.version)).rejects.toThrow("empty");
  });

  async function stockOrder(quantity = 1, paid = 0, customerId = 1, addressId = 1) {
    const [stock] = await sql`select id from inventory limit 1`;
    return OrderService.createOrder({ warehouse_id: 1, customer_id: customerId,
      payment_method: "CASH", payment_arrangement: "NET_30", amount_paid: paid,
      is_custom_shipping: false, customer_address_id: addressId,
      items: [{ inventory_id: stock.id, quantity }] });
  }

  test("checkout captures address and price; later catalog edits do not change invoice or balance", async () => {
    await seed();
    await InventoryService.createInventory({ warehouse_id: 1, product_variant_id: 1, quantity: 10 });
    const order = await stockOrder(3, 5);
    await sql`update product_variants set price=99.99`;
    await sql`update customer_addresses set address_line='Changed later'`;
    const invoice = await InvoiceService.getInvoiceByOrderId(order.id);
    expect(invoice.items[0].unit_price).toBe(12.34);
    expect(invoice.customer.address).toContain("123 Test St");
    expect(invoice.payment_status).toBe("PARTIALLY_PAID");
    expect(await PaymentService.getOrderTotal(order.id)).toBe("37.02");
    const [stock] = await sql`select quantity,reserved from inventory`;
    expect(stock).toMatchObject({ quantity: 10, reserved: 3 });
  });

  test("concurrent orders cannot oversell available stock", async () => {
    await seed();
    await sql`insert into users (email,name,password_hash,role,created_at,updated_at) values ('second@example.test','Second customer','fixture','customer',0,0)`;
    await sql`insert into customers (user_id,company_name,phone_number) values (4,'Second customer','09000000001')`;
    await sql`insert into customer_addresses (customer_id,address_line,barangay,city_municipality,province) values (2,'Second Street','Barangay','City','Province')`;
    await InventoryService.createInventory({ warehouse_id: 1, product_variant_id: 1, quantity: 3 });
    const outcomes = await Promise.allSettled([stockOrder(2), stockOrder(2, 0, 2, 2)]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [stock] = await sql`select quantity,reserved from inventory`;
    expect(stock).toMatchObject({ quantity: 3, reserved: 2 });
    expect(await sql`select id from orders`).toHaveLength(1);
  });

  test("cancellation releases a reservation once and unpaid receipts have no received date", async () => {
    await seed();
    await InventoryService.createInventory({ warehouse_id: 1, product_variant_id: 1, quantity: 3 });
    const order = await stockOrder(2);
    const [payment] = await sql`select payment_status,received_at from payments`;
    expect(payment).toMatchObject({ payment_status: "UNPAID", received_at: null });
    await OrderService.cancelOrder(order.id, 1);
    await expect(OrderService.cancelOrder(order.id, 1)).rejects.toThrow();
    const [stock] = await sql`select quantity,reserved from inventory`;
    expect(stock).toMatchObject({ quantity: 3, reserved: 0 });
  });

  test("customer active-order limit is enforced under concurrent submission", async () => {
    await seed();
    await sql`update settings set value='1' where name='customer_order_limit'`;
    await InventoryService.createInventory({ warehouse_id: 1, product_variant_id: 1, quantity: 10 });
    const outcomes = await Promise.allSettled([stockOrder(), stockOrder()]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await sql`select id from orders`).toHaveLength(1);
  });

  test("overpayment rolls back order, payment, and reservation", async () => {
    await seed();
    await InventoryService.createInventory({ warehouse_id: 1, product_variant_id: 1, quantity: 10 });
    await expect(stockOrder(1, 100)).rejects.toThrow("cannot exceed");
    expect(await sql`select id from orders`).toHaveLength(0);
    const [stock] = await sql`select reserved from inventory`;
    expect(stock.reserved).toBe(0);
  });

  test("legacy unknown prices remain unverified and cannot receive inferred payment adjustments", async () => {
    await seed();
    await InventoryService.createInventory({ warehouse_id: 1, product_variant_id: 1, quantity: 10 });
    const order = await stockOrder();
    await sql`update order_items set unit_price_snapshot=null,price_source='legacy_unknown'`;
    expect((await InvoiceService.getInvoiceByOrderId(order.id)).payment_status).toBe("UNVERIFIED");
    const [payment] = await sql`select payment_number,version from payments`;
    await expect(PaymentService.updatePayment({ payment_number: String(payment.payment_number), version: Number(payment.version), payment_amount: 1 })).rejects.toThrow("unverified");
  });

  test("role changes create missing profiles, revoke sessions, and preserve additional customer addresses", async () => {
    await seed();
    const profile = { company_name: "New customer", phone_number: "09000000000", address_line: "Primary street", barangay: "Barangay", city_municipality: "City", province: "Province", postal_code: "0000", latitude: "14", longitude: "121" };
    await UserService.updateUser(2, 1, { name: "Customer B", email: "b@example.test", role: "customer", profile }, { id: 1, tokenVersion: 0 });
    const [customer] = await sql`select id from customers where user_id=2`;
    expect(customer).toBeDefined();
    expect((await sql`select token_version from users where id=2`)[0].token_version).toBe(1);
    await sql`insert into customer_addresses (customer_id,address_line,barangay,city_municipality,province) values (${customer.id},'Other street','Other','Other','Other')`;
    await UserService.updateUser(2, 2, { name: "Customer B", email: "b@example.test", role: "customer", profile: { ...profile, address_line: "Edited street" } }, { id: 1, tokenVersion: 0 });
    const addresses = await sql`select address_line from customer_addresses where customer_id=${customer.id} order by id`;
    expect(addresses.map((a) => a.address_line)).toEqual(["Edited street", "Other street"]);
    expect((await UserService.getUsers()).rows.filter((user) => user.id === 2)).toHaveLength(1);
  });

  test("restoration is atomic, cannot be replayed, and does not revive revoked sessions", async () => {
    await seed();
    const archive = await UserService.archiveUser(1, 3, 1, { id: 1, tokenVersion: 0 });
    const outcomes = await Promise.allSettled([
      ArchiveService.restoreArchive(archive.id, { id: 1, tokenVersion: 0 }),
      ArchiveService.restoreArchive(archive.id, { id: 1, tokenVersion: 0 }),
    ]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect((await sql`select is_archived,version,token_version from users where id=3`)[0]).toMatchObject({ is_archived: false, version: 3, token_version: 1 });
    expect(await sql`select * from archives`).toHaveLength(0);
  });

  async function readyDelivery() {
    await seed();
    await sql`insert into users (email,name,password_hash,role,created_at,updated_at) values ('driver@example.test','Driver','fixture','driver',0,0)`;
    await sql`insert into drivers (user_id,warehouse_id,phone_number) values (4,1,'09000000000')`;
    await sql`insert into vehicles (warehouse_id,plate_number,image,created_at,updated_at) values (1,'TEST-001','',0,0)`;
    await InventoryService.createInventory({ warehouse_id: 1, product_variant_id: 1, quantity: 10 });
    const order = await stockOrder(2);
    await OrderService.processOrder(order.id, 1);
    await OrderService.deliveryOrder(order.id, 2);
    const data = { order_ids: [order.id], scheduled_date: "2099-01-01", scheduled_time: "09:00", delivery_type: "INTERNAL" as const, driver_id: 4, vehicle_id: 1, delivery_allowance: 0, fuel: 0, toll: 0 };
    return { order, data };
  }

  test("scheduling combobox uses saved destinations, ready status, warehouse, search and stable pages", async () => {
    const { order } = await readyDelivery();
    await stockOrder(1);
    const result = await OrderService.getAllOrderForCombobox(0, 10, "", 1);
    expect(result.total).toBe(1);
    expect(result.rows[0].id).toBe(order.id);
    expect(result.rows[0].latitude).toBe(result.rows[0].shipping_latitude);
    expect((await OrderService.getAllOrderForCombobox(0, 10, result.rows[0].order_number, 1)).total).toBe(1);
    expect((await OrderService.getAllOrderForCombobox(1, 1, "Driver", 1)).rows).toHaveLength(0);
    expect((await OrderService.getAllOrderForCombobox(0, 10, "", 999)).total).toBe(0);
    expect((await OrderService.getAllOrderForCombobox(1, 1, result.rows[0].order_number, 1)).rows).toHaveLength(0);
    const readyList = await OrderService.getAllReadyForDeliveryOrders(0, 10, result.rows[0].order_number);
    expect(readyList.total).toBe(1);
    expect(readyList.rows[0]).toMatchObject({ id: order.id, warehouse_id: 1 });
    expect((await OrderService.getAllReadyForDeliveryOrders(1, 1, result.rows[0].order_number)).rows).toHaveLength(0);
    const second = await stockOrder(1);
    await OrderService.processOrder(second.id, 1);
    await OrderService.deliveryOrder(second.id, 2);
    expect((await OrderService.getAllReadyForDeliveryOrders(0, 1)).rows[0].id).toBe(second.id);
    expect((await OrderService.getAllReadyForDeliveryOrders(1, 1)).rows[0].id).toBe(order.id);
  });

  test("schedule availability counts scheduled stops on their Manila day and cancellation releases the slot", async () => {
    const { data } = await readyDelivery();
    const options = { maxOrdersPerDay: 5, daysAhead: 30, warehouse_id: 1 };
    const before = await DeliveryScheduleService.getAvailableOrderDates(options);
    expect(before[0].available_slots).toBe(5);
    const delivery = await DeliveryService.createDelivery({ ...data, scheduled_date: before[0].date });
    expect((await DeliveryScheduleService.getAvailableOrderDates(options))[0].available_slots).toBe(4);
    expect((await DeliveryScheduleService.getAvailableOrderDates({ ...options, warehouse_id: 999 }))[0].available_slots).toBe(5);
    await DeliveryService.eventDelivery({ delivery_id: delivery.id, delivery_version: 1, event_type: "CANCELLED", reason: "Release fixture date" });
    expect((await DeliveryScheduleService.getAvailableOrderDates(options))[0].available_slots).toBe(5);
  });

  test("cross-warehouse delivery assignment is rejected without changing the order", async () => {
    const { data, order } = await readyDelivery();
    await sql`insert into warehouses(name,street_address,city,state,zip_code,created_at,updated_at) values ('Other','Street','City','Province','0000',0,0)`;
    await sql`update vehicles set warehouse_id=2 where id=1`;
    await expect(DeliveryService.createDelivery(data)).rejects.toThrow("same warehouse");
    expect((await sql`select status from orders where id=${order.id}`)[0].status).toBe("SCHEDULING");
    expect(await sql`select id from deliveries`).toHaveLength(0);
  });

  test("an order can be scheduled once; repeated dispatch consumes stock only once", async () => {
    const { order, data } = await readyDelivery();
    const outcomes = await Promise.allSettled([DeliveryService.createDelivery(data), DeliveryService.createDelivery(data)]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const [delivery] = await sql`select id from deliveries`;
    await Promise.all([DeliveryService.dispatchDelivery(delivery.id), DeliveryService.dispatchDelivery(delivery.id)]);
    expect((await sql`select quantity,reserved from inventory`)[0]).toMatchObject({ quantity: 8, reserved: 0 });
    expect((await sql`select status,stock_reserved from orders where id=${order.id}`)[0]).toMatchObject({ status: "IN_TRANSIT", stock_reserved: false });
    expect((await sql`select status from vehicles`)[0].status).toBe("on_delivery");
  });

  test("cancelled delivery retains stock reservation and returns the order for scheduling", async () => {
    const { order, data } = await readyDelivery();
    const delivery = await DeliveryService.createDelivery(data);
    await DeliveryService.eventDelivery({ delivery_id: delivery.id, delivery_version: 1, event_type: "CANCELLED", reason: "Fixture cancellation" });
    expect((await sql`select status,stock_reserved from orders where id=${order.id}`)[0]).toMatchObject({ status: "SCHEDULING", stock_reserved: true });
    expect((await sql`select quantity,reserved from inventory`)[0]).toMatchObject({ quantity: 10, reserved: 2 });
    await expect(DeliveryService.dispatchDelivery(delivery.id)).rejects.toThrow();
  });

  test("overdue schedules block dispatch without consuming stock and appear in dashboard exceptions", async () => {
    const { data } = await readyDelivery();
    const delivery = await DeliveryService.createDelivery({ ...data, scheduled_date: "2020-01-01" });
    await expect(DeliveryService.dispatchDelivery(delivery.id)).rejects.toThrow("Reschedule");
    expect((await sql`select quantity,reserved from inventory`)[0]).toMatchObject({ quantity: 10, reserved: 2 });
    expect((await DashboardService.getExceptions()).overdueDeliveries).toBe(1);
    expect(await DashboardService.getUpcomingDeliveries()).toHaveLength(0);
  });

  test("inventory cards and checkout availability use unreserved units", async () => {
    await seed();
    const [item] = await InventoryService.createInventory({ warehouse_id: 1, product_variant_id: 1, quantity: 10 });
    await stockOrder(2);
    expect(await InventoryService.getSummary(1)).toMatchObject({ skus: 1, low: 1, out: 0, reserved: 2, available: 8 });
    expect((await InventoryService.getInventoryDetailById([item.id]))[0].quantity).toBe(8);
    expect(await InventoryService.getSummary(999)).toMatchObject({ skus: 0, low: 0, out: 0, reserved: 0, available: 0 });
  });

  test("concurrent payment updates accept one version and reject overpayment without changing the balance", async () => {
    await seed();
    await InventoryService.createInventory({ warehouse_id: 1, product_variant_id: 1, quantity: 10 });
    await stockOrder();
    const [payment] = await sql`select payment_number,version from payments`;
    const input = { payment_number: String(payment.payment_number), version: Number(payment.version), payment_amount: 5 };
    const outcomes = await Promise.allSettled([PaymentService.updatePayment(input), PaymentService.updatePayment(input)]);
    expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    await expect(PaymentService.updatePayment({ ...input, version: 2, payment_amount: 10 })).rejects.toThrow("exceeds");
    expect((await sql`select amount,payment_status,version from payments`)[0]).toMatchObject({ amount: "5.00", payment_status: "PARTIALLY_PAID", version: 2 });
  });
  test("selected address coordinates are snapshotted and never taken from a different saved address", async () => {
    await seed();
    await sql`insert into customer_addresses (customer_id,address_line,barangay,city_municipality,province,latitude,longitude) values (1,'Second destination','B','C','P','15.3','120.8')`;
    await InventoryService.createInventory({ warehouse_id: 1, product_variant_id: 1, quantity: 10 });
    const order = await stockOrder(1, 0, 1, 2);
    await sql`update customer_addresses set latitude='1',longitude='2' where id=2`;
    await OrderService.processOrder(order.id, 1); await OrderService.deliveryOrder(order.id, 2);
    await sql`insert into users (email,name,password_hash,role,created_at,updated_at) values ('driver@example.test','Driver','fixture','driver',0,0)`;
    await sql`insert into vehicles (warehouse_id,plate_number,image,created_at,updated_at) values (1,'LOC-001','',0,0)`;
    await sql`insert into drivers(user_id,warehouse_id,status,phone_number) values (4,1,'available','09000000000')`;
    const delivery = await DeliveryService.createDelivery({ order_ids: [order.id], scheduled_date: '2099-01-01', scheduled_time: '09:00', delivery_type: 'INTERNAL', driver_id: 4, vehicle_id: 1, delivery_allowance: 0, fuel: 0, toll: 0 });
    expect((await sql`select latitude,longitude from deliveries_stops where delivery_id=${delivery.id}`)[0]).toMatchObject({ latitude: '15.300000', longitude: '120.800000' });
  });

  test("missing destination blocks scheduling until versioned confirmation", async () => {
    const { order, data } = await readyDelivery();
    await sql`update orders set shipping_latitude=null,shipping_longitude=null where id=${order.id}`;
    await expect(DeliveryService.createDelivery(data)).rejects.toThrow("Confirm destination");
    expect(await sql`select * from deliveries`).toHaveLength(0);
    await OrderService.setDestination(order.id, 3, 14.6, 121.2);
    await expect(OrderService.setDestination(order.id, 3, 14.7, 121.3)).rejects.toThrow("changed");
    await DeliveryService.createDelivery(data);
    await expect(OrderService.setDestination(order.id, 5, 14.7, 121.3)).rejects.toThrow("before scheduling");
  });

  test("legacy reconciliation detects stale previews and records its corrections", async () => {
    await seed(); await InventoryService.createInventory({ warehouse_id: 1, product_variant_id: 1, quantity: 10 });
    await stockOrder(2);
    await sql`update orders set stock_reserved=false`;
    await sql`update inventory set reserved=0`;
    const preview = await reconciliation.previewReconciliation();
    expect(preview.legacyOrders).toBe(1);
    expect(preview.rows[0].expected_reserved).toBe(2);
    expect(preview.rows[0].sku).toBe("FIXTURE");
    expect(preview.rows[0].warehouse).toBe("Fixture");
    await sql`update inventory set version=version+1`;
    await expect(reconciliation.reconcileReservations(preview.token, 'Legacy review', 1)).rejects.toThrow("changed");
    const current = await reconciliation.previewReconciliation();
    await reconciliation.reconcileReservations(current.token, 'Confirmed active orders', 1);
    expect((await sql`select reserved from inventory`)[0].reserved).toBe(2);
    expect((await sql`select stock_reserved from orders`)[0].stock_reserved).toBe(true);
    expect((await InventoryService.getMovements(1))[0].kind).toBe('reconciliation');
    expect((await InventoryService.getReorderSuggestions()).rows[0].suggested).toBe(3);
  });

  test("refunds are versioned, idempotent, bounded by received money and admin-only", async () => {
    await seed(); await InventoryService.createInventory({ warehouse_id: 1, product_variant_id: 1, quantity: 10 });
    await stockOrder(1, 10);
    const input = { payment_number: 'PAY-000001', amount: 4, version: 1, reason: 'Customer return', request_id: crypto.randomUUID() };
    await Promise.all([PaymentService.refund(input, 1), PaymentService.refund(input, 1)]);
    expect((await sql`select amount,refunded_amount,version from payments`)[0]).toMatchObject({ amount: '6.00', refunded_amount: '4.00', version: 2 });
    expect(await PaymentService.getRefunds(input.payment_number)).toHaveLength(1);
    for (const [actor, amount, expected] of [[1, 7, "exceeds"], [3, 1, "administrator"]] as const) {
      let rejected = false;
      try { await PaymentService.refund({ ...input, request_id: crypto.randomUUID(), version: 2, amount }, actor); }
      catch (error) { rejected = true; expect(error instanceof Error ? error.message : String(error)).toContain(expected); }
      expect(rejected).toBe(true);
    }
    await PaymentService.refund({ ...input, request_id: crypto.randomUUID(), version: 2, amount: 6 }, 1);
    const row = await PaymentService.getPaymentTableRowByNumber(input.payment_number);
    expect(row).toMatchObject({ amount: '0.00', refunded_amount: '10.00', gross_received: '10.00' });
  });

  test("fully paid rows remain visible after collection and cancelled orders cannot receive more money", async () => {
    await seed(); await InventoryService.createInventory({ warehouse_id: 1, product_variant_id: 1, quantity: 10 });
    const order = await stockOrder(1, 12.34);
    expect(await PaymentService.getPaymentTableRowByNumber('PAY-000001')).toMatchObject({ payment_status: 'PAID' });
    await OrderService.cancelOrder(order.id, 1);
    await expect(PaymentService.updatePayment({ payment_number: 'PAY-000001', payment_amount: 1, version: 1 })).rejects.toThrow("cancelled");
    expect(await PaymentService.getPaymentTableRowByNumber('PAY-000001')).toMatchObject({ remaining_amount: '0' });
  });

  test("product edits append new variants without IDs and duplicate SKUs roll back the whole draft", async () => {
    await seed();
    const current = await ProductService.getProductById(1);
    const variant = { name: "New variant", sku: "NEW-SKU", price: "15.67", unit: "box", weight_kg: "1", width_value: "1", width_unit: "m", length_value: "2", length_unit: "m", description: "New description" };
    await ProductService.updateProductById(1, { ...current!, variants: [...current!.variants, variant] } as Parameters<typeof ProductService.updateProductById>[1]);
    const saved = await ProductService.getProductById(1);
    expect(saved!.variants).toHaveLength(2);
    expect(saved!.variants.find(row => row.sku === "NEW-SKU")!.price).toBe("15.67");
    await expect(ProductService.updateProductById(1, { ...saved!, name: "Must roll back", variants: [...saved!.variants, { ...variant, sku: "FIXTURE" }] } as Parameters<typeof ProductService.updateProductById>[1])).rejects.toThrow("already in use");
    const unchanged = await ProductService.getProductById(1);
    expect(unchanged!.name).toBe(current!.name);
    expect(unchanged!.version).toBe(saved!.version);
    expect(unchanged!.variants).toHaveLength(2);
  });

  test("products search matches variants and inventory-linked products cannot be deleted", async () => {
    await seed();
    expect((await ProductService.getProductByOffset(0, 10, 'FIXTURE')).rows).toHaveLength(1);
    expect((await ProductService.getProductByOffset(0, 10, '', 'without')).rows).toHaveLength(0);
    await InventoryService.createInventory({ warehouse_id: 1, product_variant_id: 1, quantity: 0 });
    await expect(ProductService.deleteProductById(1, 1)).rejects.toThrow("linked to inventory");
  });

  test("real JWT login, refresh, logout and role restrictions use current database sessions", async () => {
    await seed();
    const hash = await require('bcrypt').hash('fixture-password', 4);
    await sql`update users set password_hash=${hash} where id=1`;
    const tokenRequestStart = Math.floor(Date.now()/1000);
    const login = await authApp.handle(new Request('http://localhost/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@example.test', password: 'fixture-password', is_mobile: false }) }));
    expect(login.status).toBe(200);
    const tokens = await login.json() as { access_token: string; refresh_token: string };
    const claims = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString());
    const tokenRequestEnd = Math.floor(Date.now()/1000);
    expect(claims.token_type).toBe('access');
    // The installed signer stamps iat when signing; exp is captured before its async work.
    expect(claims.exp).toBeGreaterThanOrEqual(tokenRequestStart + 900);
    expect(claims.exp).toBeLessThanOrEqual(tokenRequestEnd + 900);
    expect(claims.iat).toBeGreaterThanOrEqual(tokenRequestStart);
    expect(claims.iat).toBeLessThanOrEqual(tokenRequestEnd);
    const cookie = `access_token=${tokens.access_token}; refresh_token=${tokens.refresh_token}`;
    expect((await authApp.handle(new Request('http://localhost/payments', { headers: { cookie } }))).status).toBe(200);
    expect((await authApp.handle(new Request('http://localhost/auth/refresh', { method: 'POST', headers: { cookie } }))).status).toBe(200);
    expect((await authApp.handle(new Request('http://localhost/auth/refresh', { method: 'POST', headers: { cookie: `refresh_token=${tokens.access_token}` } }))).status).toBe(401);
    await authApp.handle(new Request('http://localhost/auth/logout', { method: 'POST', headers: { cookie } }));
    expect((await authApp.handle(new Request('http://localhost/payments', { headers: { cookie } }))).status).toBe(401);
    expect((await authApp.handle(new Request('http://localhost/auth/refresh', { method: 'POST', headers: { cookie } }))).status).toBe(401);
    await sql`update users set role='staff' where id=1`;
    const staffLogin = await authApp.handle(new Request('http://localhost/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@example.test', password: 'fixture-password', is_mobile: false }) }));
    const staff = await staffLogin.json() as { access_token: string };
    expect((await authApp.handle(new Request('http://localhost/inventory', { headers: { cookie: `access_token=${staff.access_token}` } }))).status).toBe(200);
    expect((await authApp.handle(new Request('http://localhost/users', { headers: { cookie: `access_token=${staff.access_token}` } }))).status).toBe(403);
  });

  test("stock adjustment reasons and movement balances are recorded; empty stock is absent from checkout options", async () => {
    await seed();
    const [item] = await InventoryService.createInventory({ warehouse_id: 1, product_variant_id: 1, quantity: 10 });
    await InventoryService.updateInventory(item.id, { warehouse_id: 1, product_variant_id: 1, quantity: 9, reserved: 0, version: 1, reason: 'Physical count correction' }, 1);
    expect((await InventoryService.getMovements(item.id))[0]).toMatchObject({ kind: 'adjustment', quantity_delta: -1, quantity_after: 9, actor: 'Admin A' });
    await InventoryService.updateInventory(item.id, { warehouse_id: 1, product_variant_id: 1, quantity: 0, reserved: 0, version: 2, reason: 'Written off after inspection' }, 1);
    expect((await InventoryService.getInventoryNames(0, 10, 1)).total).toBe(0);
  });

  test("refund ledger write failure rolls back net amount and permits a later valid retry", async () => {
    await seed(); await InventoryService.createInventory({ warehouse_id: 1, product_variant_id: 1, quantity: 10 }); await stockOrder(1, 10);
    await sql`alter table payment_refunds add constraint fixture_reject_refund check (reason <> 'Reject fixture')`;
    const input = { payment_number: 'PAY-000001', amount: 3, version: 1, reason: 'Reject fixture', request_id: crypto.randomUUID() };
    try {
      let failed = false; try { await PaymentService.refund(input, 1); } catch { failed = true; }
      expect(failed).toBe(true);
      expect((await sql`select amount,refunded_amount,version from payments`)[0]).toMatchObject({ amount: '10.00', refunded_amount: '0.00', version: 1 });
      expect(await sql`select id from payment_refunds`).toHaveLength(0);
    } finally { await sql`alter table payment_refunds drop constraint fixture_reject_refund`; }
    await PaymentService.refund({ ...input, reason: 'Confirmed return' }, 1);
    expect((await sql`select amount from payments`)[0].amount).toBe('7.00');
  });

  test("checkout payment arrangements match received money and card payments are supported", async () => {
    await seed(); await InventoryService.createInventory({ warehouse_id: 1, product_variant_id: 1, quantity: 10 });
    const input = { warehouse_id: 1, customer_id: 1, payment_method: 'CARD' as const, payment_arrangement: 'FULLY_PAID' as const, amount_paid: 0, is_custom_shipping: false, customer_address_id: 1, items: [{ inventory_id: 1, quantity: 1 }] };
    let rejected = false; try { await OrderService.createOrder(input); } catch (error) { rejected = true; expect((error as Error).message).toContain('complete order amount'); }
    expect(rejected).toBe(true); expect(await sql`select id from orders`).toHaveLength(0);
    await OrderService.createOrder({ ...input, amount_paid: 12.34 });
    expect((await sql`select payment_method,payment_status from payments`)[0]).toMatchObject({ payment_method: 'CARD', payment_status: 'PAID' });
  });

  test("account revocation notifies live sessions only after committed deactivation", async () => {
    await seed();
    const { onSessionRevoked } = require('../src/utils/session-events');
    let closed = 0; const unsubscribe = onSessionRevoked(3, () => { closed++; });
    try {
      await UserService.archiveUser(1, 3, 1, { id: 1, tokenVersion: 0 });
      expect(closed).toBe(1);
      await UserService.revokeSession(3, 0);
      expect(closed).toBe(1);
    } finally { unsubscribe(); }
  });

  test("deadlocked stock work retries the entire transaction without duplicating quantity changes", async () => {
    await seed();
    await sql`insert into product_variants (product_id,name,sku,price,unit) values (1,'Second variant','SECOND',1,'piece')`;
    await InventoryService.createInventory({ warehouse_id: 1, product_variant_id: 1, quantity: 10 });
    await InventoryService.createInventory({ warehouse_id: 1, product_variant_id: 2, quantity: 10 });
    const { stockTransaction } = require('../src/modules/inventory/transaction');
    const { sql: statement } = require('drizzle-orm');
    const attempts = [0, 0]; let entered = 0; let release: () => void = () => {};
    const ready = new Promise<void>((resolve) => { release = resolve; });
    const work = (first: number, second: number, index: number) => stockTransaction(async (tx: import('../src/modules/inventory/transaction').StockTransaction) => {
      attempts[index]++;
      await tx.execute(statement`set local deadlock_timeout = '100ms'`);
      await tx.execute(statement`update inventory set quantity=quantity+1 where id=${first}`);
      if (attempts[index] === 1) { entered++; if (entered === 2) release(); await ready; }
      await tx.execute(statement`update inventory set quantity=quantity+1 where id=${second}`);
    });
    await Promise.all([work(1, 2, 0), work(2, 1, 1)]);
    expect(attempts[0] + attempts[1]).toBe(3);
    expect((await sql`select quantity from inventory order by id`).map((row) => row.quantity)).toEqual([12, 12]);
  });

  async function rejected(action: () => Promise<unknown>, message: string) { let failure: unknown; try { await action(); } catch (error) { failure = error; } expect(failure instanceof Error ? failure.message : "NO ERROR").toContain(message); }
  test("GPS survives new source instances and ignores duplicate and older fixes", async () => {
    await seed();
    await sql`insert into vehicles (warehouse_id,plate_number,type,status,image,created_at,updated_at) values (1,'GPS-1','truck','available','',0,0)`;
    const { recordPosition } = require('../src/modules/fleet-map/fleet.service');
    const { DatabasePositionSource } = require('../src/modules/fleet-map/source');
    const first = new Date(Date.now()-60_000).toISOString();
    const second = new Date(Date.now()-30_000).toISOString();
    expect((await recordPosition(1, { latitude: 14.5, longitude: 121.1, recordedAt: first })).accepted).toBe(true);
    expect((await recordPosition(1, { latitude: 14.6, longitude: 121.2, recordedAt: second, accuracyM: 5 })).accepted).toBe(true);
    expect((await recordPosition(1, { latitude: 14.4, longitude: 121, recordedAt: first })).accepted).toBe(false);
    expect((await recordPosition(1, { latitude: 14.4, longitude: 121, recordedAt: second })).accepted).toBe(false);
    const [fix] = await new DatabasePositionSource().latest();
    expect(fix.latitude).toBe(14.6); expect(fix.sampleIntervalSeconds).toBe(30); expect(fix.accuracyM).toBe(5);
    await rejected(() => recordPosition(1, { latitude: 91, longitude: 121 }), 'Invalid GPS');
    await rejected(() => recordPosition(1, { latitude: 14, longitude: 121, recordedAt: new Date(Date.now()+60_000).toISOString() }), 'ahead');
  });
  test("calendar edit/delete enforce versions and reject invalid times and dates", async () => {
    await seed(); const { CalendarService } = require('../src/modules/calendar/services'); await sql`truncate calendar_events restart identity`;
    const data = { title: 'Morning', category: 'STAFF_SCHEDULE', date: '2026-10-31', start_time: '07:00', end_time: '08:00' };
    await CalendarService.createEvent(data); await CalendarService.updateEvent(1, { ...data, title: 'Updated', version: 1 });
    await rejected(() => CalendarService.updateEvent(1, { ...data, version: 1 }), 'changed');
    await rejected(() => CalendarService.createEvent({ ...data, end_time: '07:00:00' }), 'end time');
    await rejected(() => CalendarService.createEvent({ ...data, date: '2026-02-30' }), 'valid date');
    expect(await sql`select id from calendar_events`).toHaveLength(1); await CalendarService.deleteEvent(1, 2); expect(await sql`select id from calendar_events`).toHaveLength(0);
  });
  test("cashflow keeps collection dates and refund dates; CSV and XLSX match preview", async () => {
    await seed(); await InventoryService.createInventory({ warehouse_id: 1, product_variant_id: 1, quantity: 10 }); await stockOrder(1, 5);
    await sql`update payment_receipts set received_at='2026-09-30T16:00:00Z'`;
    await PaymentService.updatePayment({ payment_number: 'PAY-000001', payment_amount: 5, version: 1 });
    await sql`update payment_receipts set received_at='2026-10-01T16:00:00Z' where id=2`;
    await PaymentService.refund({ payment_number: 'PAY-000001', amount: 10, version: 2, reason: 'Return', request_id: crypto.randomUUID() }, 1);
    await sql`update payment_refunds set created_at='2026-10-02T16:00:00Z'`;
    const { DEFAULT_FILTERS } = require('../src/modules/analysis-reports/reports.contract');
    const { getPayments } = require('../src/modules/analysis-reports/services/payments.service');
    const { buildExport, getPreview } = require('../src/modules/analysis-reports/services/export.service');
    const filters = (day: string) => ({ ...DEFAULT_FILTERS, preset: 'custom', from: day, to: day });
    expect((await getPayments(filters('2026-10-01'))).kpis).toMatchObject({ cash: 5, received: 5, refunded: 0 });
    expect((await getPayments(filters('2026-10-02'))).kpis.cash).toBe(5);
    expect((await getPayments(filters('2026-10-03'))).kpis).toMatchObject({ cash: -10, received: 0, refunded: 10 });
    const f = { ...filters('2026-10-01'), to: '2026-10-03' }; expect((await getPreview('Payment', f)).rowCount).toBe(3);
    const csv = await buildExport('Payment', 'csv', f); expect(csv.body).toContain('refund'); expect(csv.body).toContain('-10');
    const xlsx = await buildExport('Payment', 'xlsx', f); const ExcelJS = require('exceljs'); const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(xlsx.body); expect(workbook.worksheets[0].rowCount).toBe(4);
  });
  test("vehicle history cannot cascade away and stale edits fail", async () => {
    await seed(); const { VehicleService } = require('../src/modules/vehicles/service');
    await rejected(() => VehicleService.createVehicle({ warehouse_id: 1, plate_number: 'BAD', type: 'truck', image: '', status: 'on_delivery' }), 'dispatch');
    const data = { warehouse_id: 1, plate_number: 'SAFE', type: 'truck', image: '', status: 'available' };
    await VehicleService.createVehicle(data); await VehicleService.updateVehicle(1, { ...data, plate_number: 'SAFE-EDIT', version: 1 });
    await rejected(() => VehicleService.updateVehicle(1, { ...data, version: 1 }), 'Version mismatch');
    await sql`insert into users(email,name,password_hash,role,created_at,updated_at) values ('driver@fixture.test','Driver','fixture','driver',0,0)`;
    await sql`insert into deliveries(driver_id,vehicle_id,scheduled_date,departure_time,status,delivery_type) values (4,1,'2026-10-31','10:00','completed','INTERNAL')`;
    await rejected(() => VehicleService.deleteVehicle(1, 2), 'history'); expect(await sql`select id from deliveries`).toHaveLength(1);
  });

  test("concurrent final stops transition once to returning and completion releases assignments", async () => {
    const { order, data } = await readyDelivery();
    const second = await stockOrder(1); await OrderService.processOrder(second.id, 1); await OrderService.deliveryOrder(second.id, 2);
    const delivery = await DeliveryService.createDelivery({ ...data, order_ids: [order.id, second.id] });
    const { VehicleService } = require('../src/modules/vehicles/service'); const { assignVehicleWarehouse } = require('../src/modules/fleet-map/fleet.service');
    await rejected(() => VehicleService.updateVehicle(1, { warehouse_id: 1, plate_number: 'TEST-001', image: '', type: 'truck', status: 'maintenance', version: 1 }), 'scheduled/active');
    await rejected(() => assignVehicleWarehouse(1, 1), 'scheduled/active');
    await rejected(() => UserService.updateUser(4, 1, { name: "Driver", email: "driver@example.test", role: "driver", profile: { warehouse_name: "Fixture", warehouse_id: 1, status: "day_off", phone_number: "09000000000" } }, { id: 1, tokenVersion: 0 }), "scheduled/active");
    await DeliveryService.dispatchDelivery(delivery.id);
    const stops = await sql`select id from deliveries_stops order by id`;
    await Promise.all(stops.map((stop) => DeliveryService.markStopDelivered(stop.id)));
    expect((await sql`select status from deliveries`)[0].status).toBe('returning');
    expect(await DashboardService.getActiveDeliveries()).toHaveLength(1);
    expect((await sql`select count(*)::int as count from orders where status='COMPLETED'`)[0].count).toBe(2);
    await Promise.all([DeliveryService.completeDelivery(delivery.id), DeliveryService.completeDelivery(delivery.id)]);
    expect((await sql`select status from deliveries`)[0].status).toBe('completed');
    expect((await sql`select status from vehicles`)[0].status).toBe('available');
    expect((await sql`select status from drivers`)[0].status).toBe('available');
  });
  test("warehouse coordinate clearing and archive rollback preserve stored state and history", async () => {
    await seed(); const { WarehouseService } = require('../src/modules/warehouse/service');
    const data = { name: 'Fixture', street_address: 'Street', city: 'City', state: 'Province', zip_code: '0000' };
    await rejected(() => WarehouseService.updateWarehouse(1, { ...data, version: 1, latitude: 14.5 }), 'both');
    await WarehouseService.updateWarehouse(1, { ...data, version: 1, latitude: 14.5, longitude: 121.1 });
    await WarehouseService.updateWarehouse(1, { ...data, version: 2, clear_coordinates: true });
    expect((await sql`select latitude,longitude from warehouses`)[0]).toMatchObject({ latitude: null, longitude: null });
    await sql`alter table archives add constraint reject_warehouse_fixture check (entity_type <> 'warehouses')`;
    try { await rejected(() => WarehouseService.archiveWarehouse(1, 1, 3), 'Failed query'); } finally { await sql`alter table archives drop constraint reject_warehouse_fixture`; }
    expect((await sql`select is_archived,version from warehouses`)[0]).toMatchObject({ is_archived: false, version: 3 });
    await InventoryService.createInventory({ warehouse_id: 1, product_variant_id: 1, quantity: 1 });
    await rejected(() => WarehouseService.deleteWarehouse(1, 3), 'linked');
    expect(await sql`select id from inventory`).toHaveLength(1);
    await WarehouseService.archiveWarehouse(1, 1, 3);
    expect((await sql`select is_archived,version from warehouses`)[0]).toMatchObject({ is_archived: true, version: 4 });
    await rejected(() => WarehouseService.archiveWarehouse(1, 1, 3), 'archived');
    expect(await sql`select id from archives`).toHaveLength(1);
  });
  test("reports preserve unknown historical prices, neutralize formula names and reject invalid ranges", async () => {
    await seed(); await InventoryService.createInventory({ warehouse_id: 1, product_variant_id: 1, quantity: 10 }); await stockOrder();
    await sql`update order_items set unit_price_snapshot=null,price_source='legacy_unknown'`;
    await sql`update customers set company_name=' =SUM(1,2)'`;
    const { DEFAULT_FILTERS } = require('../src/modules/analysis-reports/reports.contract');
    const { getSales } = require('../src/modules/analysis-reports/services/sales.service');
    const { buildExport, getPreview } = require('../src/modules/analysis-reports/services/export.service');
    expect((await getSales(DEFAULT_FILTERS)).kpis.revenue).toBeNull();
    const csv = await buildExport('Sales', 'csv', DEFAULT_FILTERS); expect(csv.body).toContain('Unverified'); expect(csv.body).toContain("' =SUM");
    for (const type of ['Sales', 'Inventory', 'Payment', 'Delivery', 'Customer']) {
      const preview = await getPreview(type, DEFAULT_FILTERS); const xlsx = await buildExport(type, 'xlsx', DEFAULT_FILTERS);
      const ExcelJS = require('exceljs'); const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(xlsx.body); expect(workbook.worksheets[0].rowCount).toBe(preview.rowCount + 1);
    }
    await rejected(() => getSales({ ...DEFAULT_FILTERS, preset: 'custom', from: '2026-02-30', to: '2026-03-01' }), 'valid date range');
    await rejected(() => getSales({ ...DEFAULT_FILTERS, preset: 'custom', from: '2026-10-31', to: '2026-10-01' }), 'valid date range');
    const rows = await OrderService.getOrders(0, 10, 'ORD-000001', '', 'id:desc', 'PENDING'); expect(rows.total).toBe(1); expect(rows.rows).toHaveLength(1);
    expect((await OrderService.getOrders(0, 10, '', '', 'id:desc', 'COMPLETED')).total).toBe(0);
  });

  test("sales breakdowns reconcile whole product-filtered orders and exclude every unknown-price order", async () => {
    await seed();
    await InventoryService.createInventory({ warehouse_id: 1, product_variant_id: 1, quantity: 100 });
    await sql`insert into products(name) values ('Second product')`;
    await sql`insert into product_variants(product_id,name,sku,price,unit) values (2,'Second variant','SECOND',0.20,'piece')`;
    await InventoryService.createInventory({ warehouse_id: 1, product_variant_id: 2, quantity: 100 });
    const created = await OrderService.createOrder({ warehouse_id: 1, customer_id: 1, payment_method: 'CASH', payment_arrangement: 'NET_30', amount_paid: 0, is_custom_shipping: false, customer_address_id: 1, items: [{ inventory_id: 1, quantity: 1 }, { inventory_id: 2, quantity: 1 }] });
    const { DEFAULT_FILTERS } = require('../src/modules/analysis-reports/reports.contract');
    const { getSales } = require('../src/modules/analysis-reports/services/sales.service');
    const { getCustomers } = require('../src/modules/analysis-reports/services/customers.service');
    const { buildExport, getPreview } = require('../src/modules/analysis-reports/services/export.service');
    const f = { ...DEFAULT_FILTERS, products: ['1'] };
    const sales = await getSales(f);
    expect(sales.kpis).toMatchObject({ revenue: 12.54, units: 2 });
    for (const key of ['byProduct', 'byWarehouse', 'byCustomer']) expect(Math.round(sales[key].reduce((n: number, p: { value: number }) => n + p.value, 0) * 100)).toBe(1254);
    expect((await getCustomers(f)).rows[0].sales).toBe(12.54);
    expect((await getSales({ ...f, paymentMethods: ['BANK_TRANSFER'] })).kpis.revenue).toBe(0);
    expect((await getSales({ ...f, paymentMethods: ['CASH'] })).kpis.revenue).toBe(12.54);
    const preview = await getPreview('Sales', f);
    expect(preview.metadata.filters).toEqual(['products: 1']);
    const csv = await buildExport('Sales', 'csv', f);
    expect(csv.body).toContain('Period (inclusive, Asia/Manila)');
    expect(csv.body).toContain('products: 1');
    const xlsx = await buildExport('Sales', 'xlsx', f); const ExcelJS = require('exceljs'); const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(xlsx.body);
    expect(workbook.getWorksheet('Report details').getRow(5).getCell(2).value).toBe('products: 1');
    await sql`update order_items set unit_price_snapshot=null,price_source='legacy_unknown' where inventory_id=2`;
    const unknown = await getSales(f);
    expect(unknown.kpis.revenue).toBeNull();
    expect(unknown.byProduct).toEqual([]); expect(unknown.byWarehouse).toEqual([]); expect(unknown.byCustomer).toEqual([]);
    await OrderService.cancelOrder(created.id, 1);
    const cancelled = await getSales(f);
    expect(cancelled.kpis.revenue).toBe(0);
    expect(cancelled.orders[0].balance).toBe(0);
  });

  test("dashboard calendar projects actual run details and cancelled history; active drilldown excludes cancelled runs", async () => {
    const { data } = await readyDelivery();
    const second = await stockOrder();
    await sql`update orders set shipping_address='Second fixture destination' where id=${second.id}`;
    await OrderService.processOrder(second.id, 1); await OrderService.deliveryOrder(second.id, 2);
    const delivery = await DeliveryService.createDelivery({ ...data, order_ids: [...data.order_ids, second.id] });
    expect((await DashboardService.getUpcomingDeliveries())[0]).toMatchObject({ customer: 'Fixture customer', destination: 'Multiple destinations' });
    expect((await DashboardService.getActiveDeliveries())[0]).toMatchObject({ destination: 'Multiple destinations', progress: '0 / 2 stops' });
    await sql`insert into calendar_events(title,category,date,start_time,end_time) values ('Manual reminder','DELIVERY','2098-01-01','09:00','10:00')`;
    const calendarRuns = await DashboardService.getDeliveryCalendar();
    expect(calendarRuns).toHaveLength(1);
    expect(calendarRuns[0]).toMatchObject({ id: delivery.id, date: data.scheduled_date, status: "scheduled" });
    expect(calendarRuns[0].orders).toHaveLength(2);
    expect((await DeliveryService.getDelivery(0, 10, '', undefined, undefined, false, true)).total).toBe(await DeliveryService.getTotalActiveDeliveries());
    await DeliveryService.eventDelivery({ delivery_id: delivery.id, delivery_version: 1, event_type: 'CANCELLED', reason: 'Fixture cancellation' });
    expect(await DashboardService.getDeliveryCalendar()).toMatchObject([{ id: delivery.id, status: "cancelled" }]);
    expect((await DeliveryService.getDelivery(0, 10, '', undefined, undefined, false, true)).total).toBe(0);
  });

  test("reschedule validates Manila departure and a concurrent edit accepts one captured version", async () => {
    const { data } = await readyDelivery(); const delivery = await DeliveryService.createDelivery({ ...data, scheduled_date: '2020-01-01' });
    expect((await DeliveryService.getDelivery(0, 10, '', 'scheduled', undefined, true)).total).toBe(1);
    const event = { delivery_id: delivery.id, delivery_version: 1, event_type: 'RESCHEDULED' as const, reason: 'Customer requested tomorrow', scheduled_date: '2099-01-02', departure_time: '09:00' };
    await rejected(() => DeliveryService.eventDelivery({ ...event, departure_time: undefined }), 'future departure');
    await rejected(() => DeliveryService.eventDelivery({ ...event, reason: '   ' }), 'reason');
    const outcomes = await Promise.allSettled([DeliveryService.eventDelivery(event), DeliveryService.eventDelivery(event)]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await DeliveryService.getDelivery(0, 10, '', 'scheduled', undefined, true)).total).toBe(0);
    expect((await sql`select version,scheduled_date::text,departure_time from deliveries`)[0]).toMatchObject({ version: 2, scheduled_date: '2099-01-02', departure_time: '09:00:00' });
    expect(await sql`select id from deliveries_event`).toHaveLength(1);
  });

  test("order details return shipping/payment snapshots and table sorting/search pagination stay usable", async () => {
    await seed(); await InventoryService.createInventory({ warehouse_id: 1, product_variant_id: 1, quantity: 100 });
    const first = await stockOrder(1, 5); await stockOrder(2);
    const detail = await OrderService.getOrderById(first.id);
    expect(detail).toMatchObject({ id: first.id, warehouse_id: 1, customer_id: 1, payment_arrangement: 'NET_30', payment_method: 'CASH', amount_paid: 5, is_custom_shipping: false, customer_address_id: 1, version: 1 });
    expect(detail?.shipping_address).toContain('123 Test St');
    expect(detail?.items[0]).toMatchObject({ inventory_id: 1, product_id: 1, price: 12.34, quantity: 1 });
    expect(await OrderService.getOrderById(999999)).toBeNull();
    for (const key of ['product_number', 'warehouse_name', 'customer_name', 'item_count', 'total', 'unrecognized']) {
      const rows = await OrderService.getOrders(0, 10, '', '', `${key}:asc`); expect(rows.total).toBe(2); expect(rows.rows).toHaveLength(2);
    }
    expect((await OrderService.getOrders(0, 10, '', '', 'total:asc')).rows.map(row => row.total)).toEqual([12.34, 24.68]);
    expect((await OrderService.getOrders(0, 10, '', '', 'product_number:asc')).rows.map(row => row.id)).toEqual([first.id, first.id + 1]);
    const page1 = await OrderService.getOrders(0, 1, 'ORD-', '', 'id:asc');
    const page2 = await OrderService.getOrders(1, 1, 'ORD-', '', 'id:asc');
    expect(page1.total).toBe(2); expect(page2.total).toBe(2); expect(page1.rows[0].id).not.toBe(page2.rows[0].id);
  });

  test("delivery method filters order rows and counts using the assigned run", async () => {
    const { data } = await readyDelivery();
    expect((await OrderService.getOrders(0, 10, '', 'INTERNAL')).total).toBe(0);
    await DeliveryService.createDelivery(data);
    expect((await OrderService.getOrders(0, 10, '', 'INTERNAL')).total).toBe(1);
    expect((await OrderService.getOrders(0, 10, '', 'LALAMOVE')).total).toBe(0);
  });

});
