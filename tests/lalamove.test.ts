import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { LalamoveError, lalamoveRequest, signLalamove } from "../src/plugins/lalamove";
import { assertReady, internationalPhone, safeTrackingLink } from "../src/modules/lalamove/rules";
import { verifyLalamoveWebhook } from "../src/modules/lalamove/webhook-auth";
import { lalamoveCallback } from "../src/modules/lalamove/webhook-config";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
afterEach(() => { globalThis.fetch = originalFetch; for (const key of Object.keys(process.env).filter(key => key.startsWith("LALAMOVE_"))) delete process.env[key]; Object.assign(process.env, Object.fromEntries(Object.entries(originalEnv).filter(([key]) => key.startsWith("LALAMOVE_")))); });
function config() { process.env.LALAMOVE_ENABLED = "true"; process.env.LALAMOVE_API_KEY = "pk_test_fixture"; process.env.LALAMOVE_API_SECRET = "sk_test_fixture"; process.env.LALAMOVE_BASE_URL = "https://rest.sandbox.lalamove.com"; process.env.LALAMOVE_MARKET = "PH"; }

test("webhooks verify signed data and public path; tampering fails", () => {
  const data = { order: { orderId: "1234567890123456789", status: "PICKED_UP" }, updatedAt: "2026-11-09T01:00:00Z" };
  const timestamp = 1794186000;
  const signature = createHmac("sha256", "secret").update(`${timestamp}\r\nPOST\r\n/webhooks/lalamove\r\n\r\n${JSON.stringify(data)}`).digest("hex");
  const event = { apiKey: "key", timestamp, signature, eventType: "ORDER_STATUS_CHANGED", eventVersion: "v3", data };
  expect(verifyLalamoveWebhook(event, "key", "secret", "/webhooks/lalamove")).toBe(true);
  expect(verifyLalamoveWebhook(event, "key", "secret", "/api/webhooks/lalamove")).toBe(false);
  expect(verifyLalamoveWebhook({ ...event, data: { ...data, order: { ...data.order, status: "COMPLETED" } } }, "key", "secret", "/webhooks/lalamove")).toBe(false);
  expect(verifyLalamoveWebhook({ ...event, signature: "bad" }, "key", "secret", "/webhooks/lalamove")).toBe(false);
});
test("callback URL derives the public signing path and rejects mismatched or invalid configuration", () => {
  delete process.env.LALAMOVE_WEBHOOK_PATH;
  process.env.LALAMOVE_WEBHOOK_URL = "https://backend.example.test/api/webhooks/lalamove";
  expect(lalamoveCallback()).toEqual({ url: "https://backend.example.test/api/webhooks/lalamove", path: "/api/webhooks/lalamove" });
  process.env.LALAMOVE_WEBHOOK_PATH = "/webhooks/lalamove";
  expect(() => lalamoveCallback()).toThrow("must match");
  delete process.env.LALAMOVE_WEBHOOK_PATH;
  for (const url of ["http://backend.example.test/webhooks/lalamove", "https://localhost/webhooks/lalamove", "https://user:password@backend.example.test/webhooks/lalamove", "https://backend.example.test/webhooks/lalamove?secret=x", "https://backend.example.test/wrong"]) {
    process.env.LALAMOVE_WEBHOOK_URL = url;
    expect(() => lalamoveCallback()).toThrow();
  }
});
test("tracking links and payment readiness fail closed", () => {
  expect(safeTrackingLink("https://share.lalamove.com/?order=x")).toContain("share.lalamove.com");
  for (const link of ["javascript:alert(1)", "https://share.lalamove.com.evil.test/x", "http://share.lalamove.com/x", "https://user@share.lalamove.com"]) expect(safeTrackingLink(link)).toBeNull();
  expect(internationalPhone("0917 123 4567")).toBe("+639171234567");
  const order = { delivery_method: "LALAMOVE", status: "SCHEDULING", stock_reserved: true, payment_arrangement: "FULLY_PAID" };
  expect(() => assertReady(order)).not.toThrow();
  for (const overrides of [{ delivery_method: "INTERNAL" }, { status: "PROCESSING" }, { stock_reserved: false }, { payment_arrangement: "PAY_ON_DELIVERY" }]) expect(() => assertReady({ ...order, ...overrides })).toThrow();
});
test("provider client signs the exact bytes, redacts failures and never retries POST", async () => {
  config(); let calls = 0;
  globalThis.fetch = (async (url, init) => {
    calls++; expect(String(url)).toBe("https://rest.sandbox.lalamove.com/v3/orders");
    const headers = new Headers(init?.headers); const [key, timestamp, digest] = (headers.get("Authorization") ?? "").slice(5).split(":");
    expect(key).toBe("pk_test_fixture"); expect(digest).toBe(signLalamove("sk_test_fixture", timestamp, "POST", "/v3/orders", String(init?.body)));
    return new Response("secret-customer-response", { status: 500 });
  }) as typeof fetch;
  let error: unknown; try { await lalamoveRequest("POST", "/orders", { data: { quotationId: "123" } }); } catch (cause) { error = cause; }
  expect(calls).toBe(1); expect(error).toBeInstanceOf(LalamoveError); expect((error as LalamoveError).uncertain).toBe(true); expect((error as Error).message).not.toContain("secret-customer-response");
});

const testUrl = process.env.HYOPS_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("Lalamove disposable PostgreSQL lifecycle", () => {
  let sql: import("postgres").Sql;
  let service: typeof import("../src/modules/lalamove/service").LalamoveService;
  let worker: typeof import("../src/modules/lalamove/reconciliation-worker");
  const admin = { sub: 1, role: "admin" };
  let provider: { orderId: string; quotationId: string; status: string; priceBreakdown: { total: string; currency: string }; metadata: Record<string, string>; shareLink: string };
  let submissions: number;
  let mode: "normal" | "timeout" | "credit";
  beforeAll(() => {
    const url = new URL(testUrl ?? "");
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/hyops_test") throw new Error("Disposable loopback hyops_test required.");
    process.env.DATABASE_URL = testUrl;
    sql = require("postgres").default(testUrl, { onnotice: () => {} });
    service = require("../src/modules/lalamove/service").LalamoveService;
    worker = require("../src/modules/lalamove/reconciliation-worker");
  });
  afterAll(async () => { await sql?.end(); await require("../src/db").db.$client.end({ timeout: 2 }); });
  beforeEach(async () => {
    config(); submissions = 0; mode = "normal";
    await sql`truncate users, warehouses, products, inventory, settings, lalamove_events restart identity cascade`;
    await sql`insert into users (email,name,password_hash,role,created_at,updated_at) values ('admin@fixture.test','Admin','x','admin',0,0), ('customer@fixture.test','Customer','x','customer',0,0), ('staff@fixture.test','Staff','x','staff',0,0)`;
    await sql`insert into warehouses (name,street_address,city,state,zip_code,latitude,longitude,pickup_contact_name,pickup_contact_phone,created_at,updated_at) values ('Fixture','Street','City','Province','0000',14.5,121.0,'Sender','09171234567',0,0), ('Other','Street','City','Province','0000',14.5,121.0,'Other','09171234567',0,0)`;
    await sql`update warehouses set phone_number=pickup_contact_phone`;
    await sql`insert into staffs (user_id,warehouse_id) values (3,2)`;
    await sql`insert into customers (user_id,company_name,phone_number) values (2,'Customer','09171234567')`;
    await sql`insert into products (name) values ('Fixture')`;
    await sql`insert into product_variants (product_id,name,sku,price,unit) values (1,'Variant','FIX',10,'piece')`;
    await sql`insert into inventory (warehouse_id,product_id,product_variant_id,quantity,reserved,created_at,updated_at) values (1,1,1,10,2,0,0)`;
    await sql`insert into orders (order_number,warehouse_id,customer_id,status,stock_reserved,delivery_method,payment_arrangement,shipping_recipient,shipping_phone,shipping_address,shipping_latitude,shipping_longitude) values ('ORDER-FIX',1,1,'SCHEDULING',true,'LALAMOVE','FULLY_PAID','Recipient','09171234567','Destination',14.6,121.1)`;
    await sql`insert into order_items (order_id,inventory_id,quantity,unit_price_snapshot) values (1,1,2,10)`;
    await sql`insert into invoices (invoice_number,order_id,customer_id,status,issue_date) values ('INV-FIX',1,1,'ISSUED',now())`;
    await sql`insert into payments (payment_number,order_id,customer_id,payment_method,payment_status,amount,received_at) values ('PAY-FIX',1,1,'CASH','PAID',20,now())`;
    provider = { orderId: "1234567890123456789", quotationId: "quote-fixture", status: "ASSIGNING_DRIVER", priceBreakdown: { total: "125", currency: "PHP" }, metadata: {}, shareLink: "https://share.sandbox.lalamove.com/?fixture" };
    globalThis.fetch = (async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v3/cities") return Response.json({ data: [{ locode: "PH MNL", services: [{ key: "MOTORCYCLE" }] }] });
      if (path === "/v3/quotations") return Response.json({ data: { quotationId: "quote-fixture", expiresAt: new Date(Date.now() + 300000).toISOString(), serviceType: "MOTORCYCLE", stops: [{ stopId: "pickup" }, { stopId: "dropoff" }], priceBreakdown: provider.priceBreakdown } });
      if (path === "/v3/orders" && init?.method === "POST") {
        submissions++; const payload = JSON.parse(String(init.body)); provider.metadata = payload.data.metadata;
        if (mode === "timeout") throw new Error("Lost response");
        if (mode === "credit") return new Response("wallet private response", { status: 402 });
        return Response.json({ data: provider });
      }
      if (path.startsWith("/v3/orders/")) {
        if (init?.method === "DELETE") { provider.status = "CANCELED"; return new Response(null, { status: 204 }); }
        return Response.json({ data: provider });
      }
      throw new Error(`Unexpected provider call ${path}`);
    }) as typeof fetch;
  });
  async function quote() { return service.createQuotation({ order_id: 1, order_version: 1, city: "PH MNL", service_type: "MOTORCYCLE" }, admin); }
  async function book() { const q = await quote(); return service.placeOrder({ order_id: 1, order_version: 1, quotation_ref: q.quotation_ref, idempotency_key: crypto.randomUUID(), package_confirmed: true }, admin); }
  async function expectRejected(operation: Promise<unknown>, message?: string) {
    let error: unknown;
    try { await operation; } catch (cause) { error = cause; }
    expect(error).toBeInstanceOf(Error);
    if (message) expect((error as Error).message).toContain(message);
  }
  test("saved warehouse selection persists, changes the courier route, and leaves stock ownership intact", async () => {
    const oldQuote = await quote();
    await sql`update warehouses set street_address='Alternate pickup',latitude=14.7,longitude=121.2,phone_number='09179999999' where id=2`;
    await service.setPickupWarehouse(1, 1, 2, admin);
    const context = await service.context(1, admin);
    expect(context.order).toMatchObject({ warehouse_id: 1, lalamove_pickup_warehouse_id: 2, version: 2 });
    expect(context.warehouse).toMatchObject({ id: 2, phone_number: "09179999999" });
    const currentQuote = await service.createQuotation({ order_id: 1, order_version: 2, city: "PH MNL", service_type: "MOTORCYCLE" }, admin);
    expect(currentQuote.route.pickup).toMatchObject({ name: "Other", phone: "+639179999999", address: "Alternate pickup, City, Province, 0000" });
    expect(Number(currentQuote.route.pickup.lat)).toBe(14.7); expect(Number(currentQuote.route.pickup.lng)).toBe(121.2);
    await expectRejected(service.placeOrder({ order_id: 1, order_version: 2, quotation_ref: oldQuote.quotation_ref, idempotency_key: crypto.randomUUID(), package_confirmed: true }, admin), "Quotation");
    expect((await sql`select warehouse_id,quantity,reserved from inventory where id=1`)[0]).toMatchObject({ warehouse_id: 1, quantity: 10, reserved: 2 });
    expect(submissions).toBe(0);
  });
  test("warehouse selection rejects stale versions, missing phone or coordinates, archived warehouses and active bookings", async () => {
    await expectRejected(service.setPickupWarehouse(1, 99, 2, admin), "Order changed");
    await sql`update warehouses set phone_number=null where id=2`;
    await expectRejected(service.setPickupWarehouse(1, 1, 2, admin), "phone number");
    await sql`update warehouses set phone_number='09171234567',latitude=null where id=2`;
    await expectRejected(service.setPickupWarehouse(1, 1, 2, admin), "coordinates");
    await sql`update warehouses set latitude=14.5,is_archived=true where id=2`;
    await expectRejected(service.setPickupWarehouse(1, 1, 2, admin), "active warehouse");
    await book();
    const [order] = await sql`select version from orders where id=1`;
    await expectRejected(service.setPickupWarehouse(1, order.version, 1, admin));
  });
  test("pickup warehouse search paginates matches and restricts staff to their own warehouse", async () => {
    await sql`insert into warehouses (name,street_address,city,state,zip_code,created_at,updated_at) select 'Search warehouse '||n,'Street','City','State','0',0,0 from generate_series(1,12) n`;
    const first = await service.pickupWarehouses(1, 0, "Search warehouse", admin);
    const second = await service.pickupWarehouses(1, 1, "Search warehouse", admin);
    expect(first.total).toBe(12); expect(first.rows).toHaveLength(10); expect(second.rows).toHaveLength(2);
    expect(first.rows.some(a => second.rows.some(b => a.id === b.id))).toBe(false);
    await sql`update staffs set warehouse_id=1 where user_id=3`;
    const staff = { sub: 3, role: "staff" };
    expect((await service.pickupWarehouses(1, 0, "", staff)).rows.map(row => row.id)).toEqual([1]);
    expect((await service.pickupWarehouses(1, 0, "Other", staff)).rows).toHaveLength(0);
    await expectRejected(service.setPickupWarehouse(1, 1, 2, staff), "assigned warehouse");
  });
  test("warehouse phone is editable and available in warehouse listings and details", async () => {
    const { WarehouseService } = await import("../src/modules/warehouse/service");
    const data = { name: "Created warehouse", street_address: "Street", city: "City", state: "State", zip_code: "0", phone_number: "+639171234567" };
    const created = await WarehouseService.createWarehouse(data);
    expect(created.id).toBeDefined();
    await WarehouseService.updateWarehouse(created.id!, { ...data, version: 1, phone_number: "+639179999999" });
    expect((await WarehouseService.getWarehouseById(created.id!))?.phone_number).toBe("+639179999999");
    expect((await WarehouseService.getWarehouseNames(0, 10, "Created warehouse")).rows[0]?.phone_number).toBe("+639179999999");
    expect((await WarehouseService.getWarehouses(0, 10, "Created warehouse")).rows[0]?.phone_number).toBe("+639179999999");
  });
  test("pickup contact saves the name and international phone only in the order's warehouse", async () => {
    await service.pickup(1, "Pickup Contact Example", "+639171234567", admin);
    const [warehouse] = await sql`select pickup_contact_name,pickup_contact_phone,version from warehouses where id=1`;
    expect(warehouse).toMatchObject({ pickup_contact_name: "Pickup Contact Example", pickup_contact_phone: "+639171234567", version: 2 });
    expect((await service.context(1, admin)).warehouse).toMatchObject({ pickup_contact_name: "Pickup Contact Example", pickup_contact_phone: "+639171234567" });
    expect((await sql`select pickup_contact_name from warehouses where id=2`)[0].pickup_contact_name).toBe("Other");
    await expect(service.pickup(1, "Wrong warehouse", "+639171234567", { sub: 3, role: "staff" })).rejects.toThrow("warehouse");
    expect(submissions).toBe(0);
  });
  test("migration upgrades legacy rows without losing booking or notification history", async () => {
    const currentMigration = Bun.file(new URL("../src/db/migrations/0007_lalamove_order_integration.sql", import.meta.url));
    const migration = await (await currentMigration.exists() ? currentMigration : Bun.file(new URL("../src/db/__migrations/0007_lalamove_order_integration.sql", import.meta.url))).text();
    try {
      await sql.begin(async tx => {
        await tx`create schema lalamove_migration_fixture`;
        await tx`set local search_path = lalamove_migration_fixture`;
        await tx.unsafe(`create table users (id integer primary key);
          create table orders (id integer primary key);
          create table warehouses (id integer primary key);
          create table deliveries (id integer primary key, delivery_type text);
          create table deliveries_stops (id integer primary key, order_id integer, delivery_id integer);
          create table delivery_orders (id integer primary key, lalamove_order_id text constraint delivery_orders_lalamove_order_id_unique unique,
            quotation_id text not null, booked_by integer references users(id), status text not null, created_at integer not null default 1, updated_at integer not null default 1);
          create table delivery_notifications (id integer primary key, stop_id integer not null, event_key text not null, channel text not null);
          insert into users values (1); insert into orders values (1); insert into warehouses values (1);
          insert into deliveries values (1,'INTERNAL'); insert into deliveries_stops values (1,1,1);
          insert into delivery_orders values (1,'legacy-provider-id','legacy-quote',1,'COMPLETED',7,8);
          insert into delivery_notifications values (1,1,'delivered','sms');`);
        await tx.unsafe(migration);
        expect((await tx`select * from delivery_orders where id=1`)[0]).toMatchObject({ lalamove_order_id: "legacy-provider-id", created_at: 7, updated_at: 8, order_id: null, active: false });
        expect((await tx`select delivery_method from orders where id=1`)[0].delivery_method).toBe("INTERNAL");
        expect((await tx`select stop_id,booking_id from delivery_notifications where id=1`)[0]).toMatchObject({ stop_id: 1, booking_id: null });
      });
    } finally { await sql`drop schema if exists lalamove_migration_fixture cascade`; }
  });
  test("concurrent confirmations create one durable booking and preserve invoice/payment", async () => {
    const q = await quote(); const body = { order_id: 1, order_version: 1, quotation_ref: q.quotation_ref, idempotency_key: crypto.randomUUID(), package_confirmed: true };
    const [a,b] = await Promise.all([service.placeOrder(body, admin), service.placeOrder(body, admin)]);
    expect(a.id).toBe(b.id); expect(submissions).toBe(1);
    const context = await service.context(1, admin); expect(context.bookings).toHaveLength(1); expect(context.order.status).toBe("SCHEDULED"); expect(context.bookings[0].lalamove_order_id).toBe("1234567890123456789");
    expect((await sql`select quantity,reserved from inventory`)[0]).toMatchObject({ quantity: 10, reserved: 2 });
    expect((await sql`select amount,payment_status from payments`)[0]).toMatchObject({ amount: "20.00", payment_status: "PAID" });
    expect((await sql`select status from invoices`)[0].status).toBe("ISSUED");
  });
  test("pickup/completion/reassignment and duplicate refresh consume stock and queue notifications once", async () => {
    const b = await book(); provider.status = "PICKED_UP"; await service.refresh(b.id);
    provider.status = "ASSIGNING_DRIVER"; await service.refresh(b.id);
    expect((await service.context(1, admin)).order.status).toBe("IN_TRANSIT");
    provider.status = "COMPLETED"; await Promise.all([service.refresh(b.id), service.refresh(b.id)]);
    expect((await sql`select quantity,reserved from inventory`)[0]).toMatchObject({ quantity: 8, reserved: 0 });
    expect(await sql`select * from stock_movements where kind='consume'`).toHaveLength(1);
    expect(await sql`select * from delivery_notifications where booking_id=${b.id}`).toHaveLength(2);
    expect((await service.context(1, admin)).order.status).toBe("COMPLETED");
    expect(await sql`select * from deliveries`).toHaveLength(0);
  });
  test("completion received first dispatches once and stale snapshots cannot undo it", async () => {
    const b = await book(); const stale = new Date(Date.now() - 10000); provider.status = "COMPLETED"; await service.refresh(b.id);
    await service.apply(b.id, { ...provider, status: "ON_GOING" }, stale);
    expect((await service.context(1, admin)).order.status).toBe("COMPLETED"); expect(await sql`select * from stock_movements where kind='consume'`).toHaveLength(1);
  });
  test("unknown POST outcome blocks retries until administrator verifies or links it", async () => {
    mode = "timeout"; const b = await book(); expect(b.booking_state).toBe("UNKNOWN"); expect(b.active).toBe(true);
    await expect(service.createQuotation({ order_id: 1, order_version: 1, city: "PH MNL", service_type: "MOTORCYCLE" }, admin)).rejects.toThrow("active or unresolved");
    mode = "normal"; await service.resolve(b.id, "Verified actual provider ID through Partner Portal.", admin, provider.orderId);
    expect((await service.context(1, admin)).bookings[0].booking_state).toBe("CONFIRMED"); expect(submissions).toBe(1);
  });
  test("definitive provider rejection releases claim; canceled courier keeps stock and merchandise payment", async () => {
    mode = "credit"; const failed = await book(); expect(failed.booking_state).toBe("FAILED"); expect(failed.active).toBe(false);
    mode = "normal"; const b = await book(); await service.cancel(b.id, admin);
    const context = await service.context(1, admin); expect(context.order.status).toBe("SCHEDULING"); expect(context.bookings[0].active).toBe(false);
    expect((await sql`select quantity,reserved from inventory`)[0]).toMatchObject({ quantity: 10, reserved: 2 }); expect((await sql`select amount,refunded_amount from payments`)[0]).toMatchObject({ amount: "20.00", refunded_amount: "0.00" });
  });
  test("scoping, quote expiry, route changes and fulfillment claims are enforced", async () => {
    await expect(service.context(1, { sub: 3, role: "staff" })).rejects.toThrow("warehouse");
    await expect(service.context(1, { sub: 2, role: "driver" })).rejects.toThrow("Staff");
    const q = await quote(); await sql`update lalamove_quotations set expires_at=now()-interval '1 minute'`;
    await expect(service.placeOrder({ order_id: 1, order_version: 1, quotation_ref: q.quotation_ref, idempotency_key: crypto.randomUUID(), package_confirmed: true }, admin)).rejects.toThrow("expired");
    await sql`update lalamove_quotations set expires_at=now()+interval '5 minutes'`; await sql`update warehouses set phone_number='+639179999999' where id=1`;
    await expect(service.placeOrder({ order_id: 1, order_version: 1, quotation_ref: q.quotation_ref, idempotency_key: crypto.randomUUID(), package_confirmed: true }, admin)).rejects.toThrow("changed");
    const b = await book();
    await expect(service.setMethod(1, 2, "INTERNAL", admin)).rejects.toThrow();
    const OrderService = require("../src/modules/order/service").OrderService;
    expect((await OrderService.getAllOrderForCombobox(0,10,"",1)).rows).toHaveLength(0);
    await sql`update orders set status='SCHEDULING' where id=1`;
    await expect(OrderService.setDestination(1,2,14.7,121.2)).rejects.toThrow("active or unresolved");
    expect(b.active).toBe(true);
  });
  test("replacement events preserve provider aliases, delivery ownership and stock custody", async () => {
    const b = await book(); provider.status = "PICKED_UP"; await service.refresh(b.id);
    const previous = provider.orderId; provider.orderId = "2234567890123456789"; provider.status = "ASSIGNING_DRIVER";
    const data = { order: { orderId: provider.orderId }, prevOrderId: previous };
    await sql`insert into lalamove_events (dedupe_key,environment,event_type,provider_order_id,payload) values ('sandbox:PH:replacement','sandbox','ORDER_REPLACED',${provider.orderId},${sql.json(data)})`;
    await worker.processLalamoveEvents();
    const context = await service.context(1, admin); expect(context.order.status).toBe("IN_TRANSIT"); expect(context.bookings[0].lalamove_order_id).toBe(provider.orderId);
    expect(await sql`select * from lalamove_provider_ids where booking_id=${b.id}`).toHaveLength(2);
    expect(await sql`select * from stock_movements where kind='consume'`).toHaveLength(1);
  });
  test("authenticated webhook ingestion is durable, deduplicated and accepts an empty registration probe", async () => {
    const routes = require("../src/modules/lalamove/webhook").lalamoveWebhookRoutes;
    const call = (body: string) => routes.handle(new Request("http://localhost/webhooks/lalamove", { method: "POST", headers: { "Content-Type": "application/json" }, body }));
    expect((await call("")).status).toBe(200);
    expect((await call("{}")).status).toBe(200);
    expect((await call(JSON.stringify({ data: {} }))).status).toBe(401);
    const b = await book();
    const data = { order: { orderId: provider.orderId }, updatedAt: new Date().toISOString() };
    const timestamp = Math.floor(Date.now() / 1000);
    const envelope = { apiKey: process.env.LALAMOVE_API_KEY, timestamp, eventType: "ORDER_STATUS_CHANGED", eventVersion: "v3", data,
      signature: signLalamove(process.env.LALAMOVE_API_SECRET ?? "", String(timestamp), "POST", "/webhooks/lalamove", JSON.stringify(data)) };
    for (let i=0;i<2;i++) expect((await call(JSON.stringify(envelope))).status).toBe(200);
    expect(await sql`select * from lalamove_events where event_type='ORDER_STATUS_CHANGED'`).toHaveLength(1);
    provider.status = "COMPLETED"; await worker.processLalamoveEvents();
    expect((await service.context(1, admin)).order.status).toBe("COMPLETED");
    expect(await sql`select * from stock_movements where kind='consume'`).toHaveLength(1);
    expect((await service.context(1, admin)).history.length).toBeGreaterThan(0);
    expect((await service.booking(b.id, admin)).completed_at).not.toBeNull();
    // Verify registration order in the real app: callbacks bypass browser sessions,
    // while normal booking endpoints retain session authentication.
    require("./live/environment").fixtureEnvironment(); config();
    const app = require("../src/app").createApp({ automation: false });
    expect((await app.handle(new Request("http://localhost/webhooks/lalamove", { method: "POST", body: JSON.stringify(envelope), headers: { "Content-Type": "application/json" } }))).status).toBe(200);
    const unauthenticatedBooking = { order_id: 1, order_version: 1, quotation_ref: crypto.randomUUID(), idempotency_key: crypto.randomUUID(), package_confirmed: true };
    expect((await app.handle(new Request("http://localhost/lalamove/orders", { method: "POST", body: JSON.stringify(unauthenticatedBooking), headers: { "Content-Type": "application/json" } }))).status).toBe(401);
  });
  test("production reports include external delivery once, with sandbox excluded from finances", async () => {
    const b = await book(); provider.status = "COMPLETED"; await service.refresh(b.id);
    const { findExternalDeliveries } = require("../src/modules/analysis-reports/repositories/deliveries.repository");
    expect(await findExternalDeliveries()).toHaveLength(0);
    await sql`update delivery_orders set environment='production' where id=${b.id}`;
    const rows = await findExternalDeliveries(); expect(rows).toHaveLength(1); expect(rows[0].view).toMatchObject({ type: "LALAMOVE", cost: 125, status: "completed" });
    const { stopsFor } = require("../src/modules/analysis-reports/services/datasets");
    const { DEFAULT_FILTERS } = require("../src/modules/analysis-reports/reports.contract");
    const stops = await stopsFor({ ...DEFAULT_FILTERS, deliveryTypes: ["LALAMOVE"] }, Date.now()); expect(stops).toHaveLength(1); expect(stops[0].order.total).toBe(20);
  });
  test("late cancellation refresh cannot reclaim a resolved booking after explicit rebooking", async () => {
    const first = await book(); await service.cancel(first.id, admin);
    provider.orderId = "3234567890123456789"; provider.status = "ASSIGNING_DRIVER";
    const order = await service.order(1, admin);
    const q = await service.createQuotation({ order_id: 1, order_version: order.version, city: "PH MNL", service_type: "MOTORCYCLE" }, admin);
    const second = await service.placeOrder({ order_id: 1, order_version: order.version, quotation_ref: q.quotation_ref, idempotency_key: crypto.randomUUID(), package_confirmed: true }, admin);
    await service.apply(first.id, { ...provider, orderId: "1234567890123456789", status: "CANCELED" }, new Date());
    expect((await service.booking(first.id, admin)).active).toBe(false); expect((await service.booking(second.id, admin)).active).toBe(true);
    expect((await service.order(1, admin)).status).toBe("SCHEDULED"); expect(submissions).toBe(2);
  });
  test("webhook registration is explicit, admin-only, and submits the configured URL once", async () => {
    process.env.LALAMOVE_WEBHOOK_URL = "https://backend.example.test/api/webhooks/lalamove";
    process.env.LALAMOVE_WEBHOOK_PATH = "/api/webhooks/lalamove";
    let registrations = 0;
    globalThis.fetch = (async (url, options) => {
      registrations++;
      expect(String(url)).toBe("https://rest.sandbox.lalamove.com/v3/webhook");
      expect(options?.method).toBe("PATCH");
      expect(JSON.parse(String(options?.body))).toEqual({ data: { url: process.env.LALAMOVE_WEBHOOK_URL } });
      return Response.json({ data: { url: process.env.LALAMOVE_WEBHOOK_URL } });
    }) as typeof fetch;
    await expect(service.registerWebhook({ sub: 3, role: "staff" })).rejects.toThrow("Administrator");
    const setup = await service.setup(admin);
    expect(setup.callback_path).toBe("/api/webhooks/lalamove"); expect(setup.last_callback_at).toBeNull(); expect(registrations).toBe(0);
    await service.registerWebhook(admin); expect(registrations).toBe(1);
  });
  test("multi-stop booking quotes, optimizes stop order, consumes stock once, notifies per stop, and reports cost once", async () => {
    await sql`update inventory set quantity=20, reserved=7 where id=1`;
    await sql`insert into orders (order_number,warehouse_id,customer_id,status,stock_reserved,delivery_method,payment_arrangement,shipping_recipient,shipping_phone,shipping_address,shipping_latitude,shipping_longitude)
      values
        ('ORDER-M2',1,1,'SCHEDULING',true,'INTERNAL','FULLY_PAID','Recipient Two','09172222222','Address Two',14.62,121.12),
        ('ORDER-M3',1,1,'SCHEDULING',true,'LALAMOVE','NET_30','Recipient Three','09173333333','Address Three',14.64,121.14)`;
    await sql`insert into order_items (order_id,inventory_id,quantity,unit_price_snapshot) values (2,1,2,15),(3,1,3,20)`;
    await sql`insert into invoices (invoice_number,order_id,customer_id,status,issue_date) values ('INV-M2',2,1,'ISSUED',now()),('INV-M3',3,1,'ISSUED',now())`;

    // Batch switch ORDER-M2 to LALAMOVE
    const switched = await service.setMethodsBatch([{ order_id: 2, version: 1 }], "LALAMOVE", admin);
    expect(switched.orders).toEqual([{ id: 2, version: 2, delivery_method: "LALAMOVE" }]);

    let lastQuotePayload: any = null;
    let lastOrderPayload: any = null;
    provider = {
      orderId: "9934567890123456789",
      quotationId: "quote-multi",
      status: "ASSIGNING_DRIVER",
      priceBreakdown: { total: "310", currency: "PHP" },
      metadata: {},
      shareLink: "https://share.sandbox.lalamove.com/?multi",
    };
    let providerStops: any[] = [];
    globalThis.fetch = (async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v3/cities") return Response.json({ data: [{ locode: "PH MNL", services: [{ key: "SEDAN" }] }] });
      if (path === "/v3/quotations") {
        lastQuotePayload = JSON.parse(String(init?.body));
        // Simulate Lalamove optimizing dropoff order: reverse [1, 2, 3] -> [3, 1, 2]
        const reqStops = lastQuotePayload.data.stops;
        const optimized = [
          { stopId: "p-0", address: reqStops[0].address, coordinates: reqStops[0].coordinates },
          { stopId: "d-3", address: reqStops[3].address, coordinates: reqStops[3].coordinates },
          { stopId: "d-1", address: reqStops[1].address, coordinates: reqStops[1].coordinates },
          { stopId: "d-2", address: reqStops[2].address, coordinates: reqStops[2].coordinates },
        ];
        return Response.json({
          data: {
            quotationId: "quote-multi",
            expiresAt: new Date(Date.now() + 300000).toISOString(),
            serviceType: "SEDAN",
            stops: optimized,
            priceBreakdown: provider.priceBreakdown,
          },
        });
      }
      if (path === "/v3/orders" && init?.method === "POST") {
        submissions++;
        lastOrderPayload = JSON.parse(String(init.body));
        provider.metadata = lastOrderPayload.data.metadata;
        return Response.json({ data: { ...provider, stops: providerStops } });
      }
      if (path.startsWith("/v3/orders/")) {
        if (init?.method === "DELETE") { provider.status = "CANCELED"; return new Response(null, { status: 204 }); }
        return Response.json({ data: { ...provider, stops: providerStops } });
      }
      throw new Error(`Unexpected provider call ${path}`);
    }) as typeof fetch;

    const multiQuote = await service.createMultiStopQuotation({
      order_ids: [1, 2, 3],
      order_versions: { "1": 1, "2": 2, "3": 1 },
      pickup_warehouse_id: 1,
      city: "PH MNL",
      service_type: "SEDAN",
      is_route_optimized: true,
    }, admin);

    expect(lastQuotePayload.data.isRouteOptimized).toBe(true);
    expect(lastQuotePayload.data.stops).toHaveLength(4);
    expect(multiQuote.route_reordered).toBe(true);
    expect(multiQuote.route.dropoffs.map(d => d.order_id)).toEqual([3, 1, 2]);
    expect(multiQuote.route.dropoffs.map(d => d.stop_id)).toEqual(["d-3", "d-1", "d-2"]);

    const key = crypto.randomUUID();
    const body = {
      order_ids: [1, 2, 3],
      order_versions: { "1": 1, "2": 2, "3": 1 },
      pickup_warehouse_id: 1,
      quotation_ref: multiQuote.quotation_ref,
      idempotency_key: key,
      package_confirmed: true,
    };
    const [b1, b2] = await Promise.all([service.placeMultiStopOrder(body, admin), service.placeMultiStopOrder(body, admin)]);
    expect(b1.id).toBe(b2.id);
    expect(submissions).toBe(1);
    expect(b1.stop_count).toBe(3);
    expect(b1.stops.map(s => s.order_id)).toEqual([3, 1, 2]);
    expect(lastOrderPayload.data.recipients.map((r: any) => ({ stopId: r.stopId, name: r.name }))).toEqual([
      { stopId: "d-3", name: "Recipient Three" },
      { stopId: "d-1", name: "Recipient" },
      { stopId: "d-2", name: "Recipient Two" },
    ]);

    // All 3 orders are now SCHEDULED and blocked from competing bookings
    expect((await sql`select id, status from orders order by id`).map((r: any) => r.status)).toEqual(["SCHEDULED", "SCHEDULED", "SCHEDULED"]);
    await expectRejected(service.createQuotation({ order_id: 2, order_version: 3, city: "PH MNL", service_type: "SEDAN" }, admin), "ready");

    // Pickup consumes stock for all 3 orders; Stop 1 (order 3) delivers via POD while others remain IN_TRANSIT
    provider.status = "PICKED_UP";
    providerStops = [
      { stopId: "p-0" },
      { stopId: "d-3", POD: { status: "DELIVERED", deliveredAt: new Date().toISOString() } },
      { stopId: "d-1", POD: { status: "PENDING" } },
      { stopId: "d-2", POD: { status: "PENDING" } },
    ];
    await service.refresh(b1.id);
    expect(await sql`select * from stock_movements where kind='consume'`).toHaveLength(3);
    expect((await sql`select id, status from orders order by id`).map((r: any) => r.status)).toEqual(["IN_TRANSIT", "IN_TRANSIT", "COMPLETED"]);
    expect(await sql`select * from delivery_notifications where booking_id=${b1.id}`).toHaveLength(2);

    // Complete remaining stops
    provider.status = "COMPLETED";
    providerStops = [
      { stopId: "p-0" },
      { stopId: "d-3", POD: { status: "DELIVERED", deliveredAt: new Date().toISOString() } },
      { stopId: "d-1", POD: { status: "DELIVERED", deliveredAt: new Date().toISOString() } },
      { stopId: "d-2", POD: { status: "DELIVERED", deliveredAt: new Date().toISOString() } },
    ];
    await Promise.all([service.refresh(b1.id), service.refresh(b1.id)]);
    expect((await sql`select id, status from orders order by id`).map((r: any) => r.status)).toEqual(["COMPLETED", "COMPLETED", "COMPLETED"]);
    expect(await sql`select * from delivery_notifications where booking_id=${b1.id}`).toHaveLength(6);
    expect(await sql`select * from delivery_order_stops where booking_id=${b1.id} and active=true`).toHaveLength(0);

    // Production report projects 3 stops sharing one delivery.id so cost (310) is counted once
    await sql`update delivery_orders set environment='production' where id=${b1.id}`;
    const { findExternalDeliveries } = require("../src/modules/analysis-reports/repositories/deliveries.repository");
    const ext = await findExternalDeliveries();
    expect(ext).toHaveLength(3);
    expect(new Set(ext.map((r: any) => r.view.id)).size).toBe(1);
    expect(new Set(ext.map((r: any) => r.stopId)).size).toBe(3);
    expect(ext[0].view.cost).toBe(310);

    const { stopsFor } = require("../src/modules/analysis-reports/services/datasets");
    const { DEFAULT_FILTERS } = require("../src/modules/analysis-reports/reports.contract");
    const reportStops = await stopsFor({ ...DEFAULT_FILTERS, deliveryTypes: ["LALAMOVE"] }, Date.now());
    expect(reportStops).toHaveLength(3);
  });
  test("multi-stop cancellation and definitive failure release all orders cleanly", async () => {
    await sql`insert into orders (order_number,warehouse_id,customer_id,status,stock_reserved,delivery_method,payment_arrangement,shipping_recipient,shipping_phone,shipping_address,shipping_latitude,shipping_longitude)
      values ('ORDER-C2',1,1,'SCHEDULING',true,'LALAMOVE','FULLY_PAID','Recipient Two','09172222222','Address Two',14.62,121.12)`;
    globalThis.fetch = (async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v3/cities") return Response.json({ data: [{ locode: "PH MNL", services: [{ key: "MOTORCYCLE" }] }] });
      if (path === "/v3/quotations") return Response.json({ data: { quotationId: "q-c", expiresAt: new Date(Date.now() + 300000).toISOString(), serviceType: "MOTORCYCLE", stops: [{ stopId: "p" }, { stopId: "d1" }, { stopId: "d2" }], priceBreakdown: { total: "180", currency: "PHP" } } });
      if (path === "/v3/orders" && init?.method === "POST") {
        submissions++;
        if (mode === "credit") return new Response("no credit", { status: 402 });
        return Response.json({ data: provider });
      }
      if (path.startsWith("/v3/orders/")) {
        if (init?.method === "DELETE") { provider.status = "CANCELED"; return new Response(null, { status: 204 }); }
        return Response.json({ data: provider });
      }
      throw new Error(`Unexpected ${path}`);
    }) as typeof fetch;

    const q1 = await service.createMultiStopQuotation({ order_ids: [1, 2], order_versions: { "1": 1, "2": 1 }, pickup_warehouse_id: 1, city: "PH MNL", service_type: "MOTORCYCLE" }, admin);
    mode = "credit";
    const failed = await service.placeMultiStopOrder({ order_ids: [1, 2], order_versions: { "1": 1, "2": 1 }, pickup_warehouse_id: 1, quotation_ref: q1.quotation_ref, idempotency_key: crypto.randomUUID(), package_confirmed: true }, admin);
    expect(failed.booking_state).toBe("FAILED");
    expect(failed.active).toBe(false);
    expect(await sql`select * from delivery_order_stops where active=true`).toHaveLength(0);

    mode = "normal";
    const q2 = await service.createMultiStopQuotation({ order_ids: [1, 2], order_versions: { "1": 1, "2": 1 }, pickup_warehouse_id: 1, city: "PH MNL", service_type: "MOTORCYCLE" }, admin);
    const activeBooking = await service.placeMultiStopOrder({ order_ids: [1, 2], order_versions: { "1": 1, "2": 1 }, pickup_warehouse_id: 1, quotation_ref: q2.quotation_ref, idempotency_key: crypto.randomUUID(), package_confirmed: true }, admin);
    expect((await sql`select status from orders order by id`).map((r: any) => r.status)).toEqual(["SCHEDULED", "SCHEDULED"]);

    await service.cancel(activeBooking.id, admin);
    expect((await sql`select status from orders order by id`).map((r: any) => r.status)).toEqual(["SCHEDULING", "SCHEDULING"]);
    expect(await sql`select * from delivery_order_stops where active=true`).toHaveLength(0);
  });
  test("live driver coordinates refresh safely, throttle within 10s, and surface in liveActive", async () => {
    let driverCalls = 0;
    const updatedAt = "2026-11-20T13:15:00Z";
    provider = {
      orderId: "5534567890123456789",
      quotationId: "quote-live",
      status: "ON_GOING",
      priceBreakdown: { total: "145", currency: "PHP" },
      metadata: {},
      shareLink: "https://share.sandbox.lalamove.com/?live",
    };
    globalThis.fetch = (async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v3/cities") return Response.json({ data: [{ locode: "PH MNL", services: [{ key: "MOTORCYCLE" }] }] });
      if (path === "/v3/quotations") return Response.json({ data: { quotationId: "quote-live", expiresAt: new Date(Date.now() + 300000).toISOString(), serviceType: "MOTORCYCLE", stops: [{ stopId: "p" }, { stopId: "d1" }], priceBreakdown: provider.priceBreakdown } });
      if (path === "/v3/orders" && init?.method === "POST") {
        return Response.json({ data: { ...provider, driverId: "drv-88" } });
      }
      if (path === `/v3/orders/${provider.orderId}/drivers/drv-88`) {
        driverCalls++;
        return Response.json({
          data: {
            driverId: "drv-88",
            name: "Rico",
            phone: "+639175551234",
            plateNumber: "ABC 1234",
            coordinates: { lat: "14.5547", lng: "121.0244", updatedAt },
          },
        });
      }
      if (path === `/v3/orders/${provider.orderId}`) {
        return Response.json({ data: { ...provider, driverId: "drv-88" } });
      }
      throw new Error(`Unexpected ${path}`);
    }) as typeof fetch;

    const b = await book();
    // Force stale last_synced_at so liveActive triggers driver coordinate fetch
    await sql`update delivery_orders set last_synced_at = now() - interval '30 seconds' where id = ${b.id}`;
    const live = await service.liveActive(admin);
    expect(live).toHaveLength(1);
    expect(live[0].driver).toMatchObject({
      id: "drv-88",
      name: "Rico",
      plate_number: "ABC 1234",
      coordinates: { lat: 14.5547, lng: 121.0244, updated_at: updatedAt },
    });
    expect(live[0].pickup.coordinates).toEqual([121, 14.5]);
    expect(live[0].stops[0]?.coordinates).toEqual([121.1, 14.6]);
    expect(driverCalls).toBe(1);

    // Immediate refreshDriverLocation respects 10s cooldown and avoids duplicate provider call
    const cached = await service.refreshDriverLocation(b.id, admin);
    expect(cached.driver_coordinates).toEqual({ lat: 14.5547, lng: 121.0244, updated_at: updatedAt });
    expect(driverCalls).toBe(1);
  });
});
