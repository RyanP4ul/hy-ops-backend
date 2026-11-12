import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { LifecycleService as Service } from "../src/modules/lifecycle/service";

const testUrl = process.env.HYOPS_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("entity lifecycle with disposable PostgreSQL", () => {
  let sql: import("postgres").Sql;
  let LifecycleService: typeof Service;
  let InventoryService: typeof import("../src/modules/inventory/service").InventoryService;
  let VehicleService: typeof import("../src/modules/vehicles/service").VehicleService;
  let UserService: typeof import("../src/modules/user/service").UserService;
  let ArchiveService: typeof import("../src/modules/archives/service").ArchiveService;
  let OrderService: typeof import("../src/modules/order/service").OrderService;
  const actor = { id: 1, tokenVersion: 0 };
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.pathname !== "/hyops_test") throw new Error("Disposable loopback hyops_test database required.");
    process.env.DATABASE_URL = testUrl;
    sql = require("postgres").default(testUrl, { onnotice: () => {} });
    ({ LifecycleService } = require("../src/modules/lifecycle/service"));
    ({ InventoryService } = require("../src/modules/inventory/service"));
    ({ VehicleService } = require("../src/modules/vehicles/service"));
    ({ UserService } = require("../src/modules/user/service"));
    ({ ArchiveService } = require("../src/modules/archives/service"));
    ({ OrderService } = require("../src/modules/order/service"));
    await require("../src/db").db.execute(require("drizzle-orm").sql`select 1`);

  });
  afterAll(async () => {
    await require("../src/db").db.$client.end({ timeout: 1 });
    await sql.end({ timeout: 1 });
  });
  async function seed() {
    await sql`truncate users, warehouses, products, inventory, settings restart identity cascade`;
    await sql`insert into users (email,name,password_hash,role,created_at,updated_at) values
      ('admin@test.local','Admin','fixture','admin',0,0), ('customer@test.local','Customer','fixture','customer',0,0),
      ('driver@test.local','Driver','fixture','driver',0,0)`;
    await sql`insert into warehouses (name,street_address,city,state,zip_code,created_at,updated_at) values ('Warehouse','Street','City','Province','0000',0,0)`;
    await sql`insert into customers (user_id,company_name,phone_number) values (2,'Company','09000000000')`;
    await sql`insert into drivers (user_id,warehouse_id,phone_number) values (3,1,'09000000000')`;
    await sql`insert into products (name) values ('Product')`;
    await sql`insert into product_variants (product_id,name,sku,price,unit) values (1,'Variant','SKU',10,'piece')`;
    await sql`insert into inventory (warehouse_id,product_id,product_variant_id,quantity,created_at,updated_at) values (1,1,1,10,0,0)`;
    await sql`insert into vehicles (warehouse_id,plate_number,created_at,updated_at) values (1,'ABC-123',0,0)`;
  }
  const sale = () => OrderService.createWalkInOrder({ warehouse_id: 1, amount_tendered: 10, payment_method: "CASH", items: [{ inventory_id: 1, quantity: 1 }] });

  for (const resource of ["products", "inventory", "warehouses"] as const) {
    test(`${resource}: blocks selection and checkout, then reactivates without losing stock`, async () => {
      await seed();

      expect((await InventoryService.getInventoryNames(0)).total).toBe(1);

      await LifecycleService.change(resource, 1, 1, "deactivate", actor);

      expect((await InventoryService.getInventoryNames(0)).rows).toHaveLength(0);
      expect((await InventoryService.getInventoryNames(0)).total).toBe(0);
      expect((await InventoryService.getInventoryTableRowById(1)).is_operational).toBe(false);
      expect((await InventoryService.getProductByOffset(0, 10, "", "all", null, null, null, true)).total).toBe(0);
      let rejected = false;
      try { await sale(); } catch { rejected = true; }
      expect(rejected).toBe(true);

      expect(await sql`select * from orders`).toHaveLength(0);
      const [stock] = await sql`select quantity from inventory where id=1`;
      expect(stock.quantity).toBe(10);
      await LifecycleService.change(resource, 1, 2, "activate", actor);
      expect((await InventoryService.getInventoryNames(0)).total).toBe(1);

      await sale();

      expect(await sql`select * from orders`).toHaveLength(1);
    });
  }
  test("parent reactivation preserves a child's explicit inactive state", async () => {
    await seed();
    await LifecycleService.change("inventory", 1, 1, "deactivate", actor);
    await LifecycleService.change("warehouses", 1, 1, "deactivate", actor);
    expect(await UserService.getMutationActor(3)).toBeUndefined();
    expect((await UserService.getAllDrivers(0, 10)).total).toBe(0);
    expect((await VehicleService.getVehicleForCombobox(0, 10, "")).total).toBe(0);
    await LifecycleService.change("warehouses", 1, 2, "activate", actor);
    expect((await InventoryService.getInventoryNames(0)).total).toBe(0);
    expect(await UserService.getMutationActor(3)).toBeDefined();
  });
  test("users: deactivation invalidates auth and selectors without archiving", async () => {
    await seed();
    await LifecycleService.change("users", 2, 1, "deactivate", actor);
    expect(await UserService.findUserByEmail("customer@test.local")).toBeNull();
    expect(await UserService.getMutationActor(2)).toBeUndefined();
    expect((await UserService.getCustomers(0)).rows).toHaveLength(0);
    expect((await UserService.getUsers(0)).rows).toHaveLength(3);
    expect(await sql`select * from archives`).toHaveLength(0);
    const [user] = await sql`select token_version, refresh_token from users where id=2`;
    expect(user.token_version).toBe(1);
    expect(user.refresh_token).toBeNull();
    await LifecycleService.change("users", 2, 2, "activate", actor);
    expect(await UserService.getMutationActor(2)).toBeDefined();
  });
  for (const resource of ["users", "warehouses", "vehicles"] as const) {
    test(`${resource}: archive, inspect and restore with history retained`, async () => {
      await seed();
      const id = resource === "users" ? 2 : 1;
      const archived = await LifecycleService.change(resource, id, 1, "archive", actor);
      expect((await ArchiveService.getArchives(0)).rows).toHaveLength(1);
      expect(await ArchiveService.getEntityData(resource, id)).toBeDefined();
      if (resource === "vehicles") {
        expect((await VehicleService.getVehicles()).total).toBe(0);
        expect((await VehicleService.getVehicleForCombobox(0, 10, "")).total).toBe(0);
      }
      await expect(LifecycleService.change(resource, id, 2, "activate", actor)).rejects.toThrow();
      await ArchiveService.restoreArchive(archived.id, actor);
      expect((await ArchiveService.getArchives(0)).rows).toHaveLength(0);
      const [row] = await sql.unsafe(`select * from ${resource} where id=$1`, [id]);
      expect(row.is_archived).toBe(false);
      expect(row.is_active).toBe(false);
      await LifecycleService.change(resource, id, 3, "activate", actor);
    });
  }
  test("deactivation rejects open order dependencies, preserving reservations and history", async () => {
    await seed();
    await sql`insert into orders (order_number,warehouse_id,customer_id,status) values ('ORD-TEST',1,1,'PENDING')`;
    await sql`insert into order_items (order_id,inventory_id,quantity,unit_price_snapshot) values (1,1,1,10)`;
    for (const [resource, id] of [["products", 1], ["inventory", 1], ["warehouses", 1], ["users", 2]] as const) {
      await expect(LifecycleService.change(resource, id, 1, "deactivate", actor)).rejects.toThrow();
    }
    expect(await sql`select * from order_items`).toHaveLength(1);
    expect(await sql`select * from audit_logs`).toHaveLength(0);
  });
  test("scheduled trips protect vehicle and driver from archive/deactivation", async () => {
    await seed();
    await sql`insert into deliveries (driver_id,vehicle_id,scheduled_date,departure_time,status) values (3,1,'2099-01-01','08:00','scheduled')`;
    for (const [resource, id] of [["vehicles", 1], ["users", 3], ["warehouses", 1]] as const) {
      await expect(LifecycleService.change(resource, id, 1, "archive", actor)).rejects.toThrow();
    }
    expect(await sql`select * from archives`).toHaveLength(0);
  });
  test("unfinished legacy orders with disabled parties or stock cannot progress", async () => {
    await seed();
    await sql`insert into orders (order_number,warehouse_id,customer_id,status) values ('LEGACY',1,1,'PENDING')`;
    await sql`insert into order_items (order_id,inventory_id,quantity,unit_price_snapshot) values (1,1,1,10)`;
    await sql`update users set is_active=false where id=2`;
    await expect(OrderService.processOrder(1, 1)).rejects.toThrow("active customer");
    await sql`update users set is_active=true where id=2`;
    await sql`update products set is_active=false where id=1`;
    await expect(OrderService.processOrder(1, 1)).rejects.toThrow("inactive stock");
    expect((await sql`select status from orders where id=1`)[0].status).toBe("PENDING");
  });
  test("vehicle creation returns its committed row and rejects an inactive home warehouse", async () => {
    await seed();
    const vehicle = await VehicleService.createVehicle({ warehouse_id: 1, plate_number: "NEW-123", status: "available", type: "van" });
    expect("vehicle" in vehicle && vehicle.vehicle?.plate_number).toBe("NEW-123");
    await LifecycleService.change("warehouses", 1, 1, "deactivate", actor);
    await expect(VehicleService.createVehicle({ warehouse_id: 1, plate_number: "NEW-456", status: "available", type: "van" })).rejects.toThrow("active warehouse");
    expect((await VehicleService.getVehicles()).total).toBe(2);
    expect((await VehicleService.getVehicleForCombobox(0, 10, "")).total).toBe(0);
  });
  test("concurrent checkout and product deactivation cannot sell unavailable stock", async () => {
    await seed();
    const outcomes = await Promise.allSettled([sale(), LifecycleService.change("products", 1, 1, "deactivate", actor)]);
    expect(outcomes[1].status).toBe("fulfilled");
    const [stock] = await sql`select quantity,reserved from inventory where id=1`;
    expect(stock.quantity).toBe(outcomes[0].status === "fulfilled" ? 9 : 10);
    expect(stock.reserved).toBe(0);
    expect((await InventoryService.getInventoryNames(0)).total).toBe(0);
  });
  test("archiving preserves completed order details and stock movement history", async () => {
    await seed();
    const order = await sale();
    const archived = await LifecycleService.change("warehouses", 1, 1, "archive", actor);
    expect(await OrderService.getOrderById(order.id)).toBeDefined();
    expect(await InventoryService.getMovements(1)).toHaveLength(2);
    expect((await InventoryService.getProductByOffset(0)).total).toBe(0);
    await ArchiveService.restoreArchive(archived.id, actor);
    expect(await OrderService.getOrderById(order.id)).toBeDefined();
  });
  test("failed archive insertion rolls back activation flag, version and token revocation", async () => {
    await seed();
    await sql`alter table archives add constraint lifecycle_reject_archive check (entity_type <> 'users')`;
    try {
      await expect(LifecycleService.change("users", 2, 1, "archive", actor)).rejects.toThrow();
      const [row] = await sql`select is_active,is_archived,version,token_version from users where id=2`;
      expect(row).toMatchObject({ is_active: true, is_archived: false, version: 1, token_version: 0 });
      expect(await sql`select * from audit_logs`).toHaveLength(0);
    } finally { await sql`alter table archives drop constraint lifecycle_reject_archive`; }
  });
  test("HTTP lifecycle routes validate versions and enforce administrator permissions", async () => {
    await seed();
    const { Elysia } = require("elysia");
    const { lifecycleRoutes } = require("../src/modules/lifecycle");
    const app = (id: number) => new Elysia().onError(({ error, set }: any) => { set.status = error.status ?? 500; return { message: error.message }; })
      .resolve(() => ({ user: { sub: String(id), token_version: 0 } })).use(lifecycleRoutes);
    const request = (resource: string, action: string, version: number) => new Request(`http://localhost/${resource}/1/${action}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ version }),
    });
    expect((await app(2).handle(request("products", "deactivate", 1))).status).toBe(403);
    for (const resource of ["products", "inventory", "vehicles", "warehouses"]) {
      expect((await app(1).handle(request(resource, "deactivate", 1))).status).toBe(200);
      expect((await app(1).handle(request(resource, "activate", 2))).status).toBe(200);
    }
    expect((await app(1).handle(request("vehicles", "archive", 3))).status).toBe(200);
    expect((await VehicleService.getVehicles()).total).toBe(0);
  });
  test("stale versions, self deactivation and non-admin actors are rejected", async () => {
    await seed();
    await expect(LifecycleService.change("users", 1, 1, "deactivate", actor)).rejects.toThrow();
    await expect(LifecycleService.change("products", 1, 2, "deactivate", actor)).rejects.toThrow();
    await expect(LifecycleService.change("products", 1, 1, "deactivate", { id: 2, tokenVersion: 0 })).rejects.toThrow();
    const outcomes = await Promise.allSettled([LifecycleService.change("products", 1, 1, "deactivate", actor), LifecycleService.change("products", 1, 1, "deactivate", actor)]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
  });
});

