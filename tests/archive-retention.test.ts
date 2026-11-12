import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

const testUrl = process.env.HYOPS_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("archive retention on disposable PostgreSQL", () => {
  let sql: import("postgres").Sql;
  let lifecycle: typeof import("../src/modules/lifecycle/service").LifecycleService;
  let archiveService: typeof import("../src/modules/archives/service").ArchiveService;
  let retention: typeof import("../src/modules/archives/retention");
  const actor = { id: 1, tokenVersion: 0 };
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.pathname !== "/hyops_test") throw new Error("Disposable loopback hyops_test database required.");
    process.env.DATABASE_URL = testUrl;
    process.env.JWT_SECRET = "retention-fixture-access-signing-key";
    process.env.REFRESH_TOKEN_SECRET = "retention-fixture-refresh-signing-key";
    sql = require("postgres").default(testUrl, { onnotice: () => {} });
    ({ LifecycleService: lifecycle } = require("../src/modules/lifecycle/service"));
    ({ ArchiveService: archiveService } = require("../src/modules/archives/service"));
    retention = require("../src/modules/archives/retention");
    await require("../src/db").db.execute(require("drizzle-orm").sql`select 1`);
  });
  afterAll(async () => {
    await require("../src/db").db.$client.end({ timeout: 1 });
    await sql.end({ timeout: 1 });
  });
  beforeEach(async () => {
    await sql`truncate users, warehouses, products, inventory, settings restart identity cascade`;
    await sql`insert into users(email,name,password_hash,role,created_at,updated_at) values
      ('admin@test.local','Admin','fixture','admin',0,0),('customer@test.local','Customer','fixture','customer',0,0),('driver@test.local','Driver','fixture','driver',0,0)`;
    await sql`insert into warehouses(name,street_address,city,state,zip_code,created_at,updated_at) values ('Warehouse','Street','City','Province','0000',0,0)`;
    await sql`insert into customers(user_id,company_name,phone_number) values (2,'Company','09000000000')`;
    await sql`insert into customer_addresses(customer_id,address_line,barangay,city_municipality,province) values (1,'Street','Barangay','City','Province')`;
    await sql`insert into products(name) values ('Product')`;
    await sql`insert into product_variants(product_id,name,sku,price,unit) values (1,'Variant','SKU',10,'piece')`;
    await sql`insert into inventory(warehouse_id,product_id,product_variant_id,quantity,created_at,updated_at) values (1,1,1,0,0,0)`;
    await sql`insert into vehicles(warehouse_id,plate_number,created_at,updated_at) values (1,'ABC-123',0,0)`;
  });
  async function rejected(work: () => Promise<unknown>, message?: string) {
    let error: unknown;
    try { await work(); } catch (caught) { error = caught; }
    expect(error).toBeDefined();
    if (message) expect((error as Error).message).toContain(message);
  }
  async function due(resource: "products" | "inventory" | "warehouses" | "vehicles" | "users", entityId = 1) {
    const archive = await lifecycle.change(resource, entityId, 1, "archive", actor);
    await retention.scheduleArchiveDeletion(archive.id, actor);
    // Time travel only this disposable fixture's records; production worker takes
    // no caller-controlled timestamp and always reads the database clock.
    const [time] = await sql`select floor(extract(epoch from clock_timestamp()))::int as now`;
    const old = time.now - retention.RETENTION_SECONDS - 60;
    await sql.unsafe(`update ${resource} set archived_at=$1 where id=$2`, [old, entityId]);
    await sql`update archives set archived_at=${old},deletion_requested_at=${old},delete_after=${old + retention.RETENTION_SECONDS} where id=${archive.id}`;
    return archive;
  }

  for (const resource of ["products", "inventory"] as const) {
    test(`${resource}: archiving retains rows, removes selection, and restores inactive`, async () => {
      const archived = await lifecycle.change(resource, 1, 1, "archive", actor);
      expect(await sql.unsafe(`select id from ${resource} where id=1`)).toHaveLength(1);
      const data = await archiveService.getEntityData(resource, 1);
      expect(data).toBeDefined();
      expect((await archiveService.getArchives(0)).total).toBe(1);
      const { InventoryService } = require("../src/modules/inventory/service");
      expect((await InventoryService.getInventoryNames(0)).total).toBe(0);
      if (resource === "products") {
        const { ProductService } = require("../src/modules/products/service");
        expect((await ProductService.getProductByOffset(0)).total).toBe(0);
        const { ProductVariantService } = require("../src/modules/product_variant/service");
        expect((await ProductVariantService.getProductVariants(0)).total).toBe(0);
      } else expect((await InventoryService.getProductByOffset(0)).total).toBe(0);
      const [metadata] = await sql`select delete_after from archives where id=${archived.id}`;
      expect(metadata.delete_after).toBeNull();
      await archiveService.restoreArchive(archived.id, actor);
      const [restored] = await sql.unsafe(`select is_archived,is_active from ${resource} where id=1`);
      expect(restored).toMatchObject({ is_archived: false, is_active: false });
    });
  }
  test("Delete schedules a full 30 days using DB time; repeated clicks never shorten or extend it", async () => {
    const archived = await lifecycle.change("vehicles", 1, 1, "archive", actor);
    const [before] = await sql`select floor(extract(epoch from clock_timestamp()))::int as now`;
    const scheduled = await retention.scheduleArchiveDeletion(archived.id, actor);
    expect(scheduled.delete_after).toBeGreaterThanOrEqual(before.now + retention.RETENTION_SECONDS);
    expect((await retention.scheduleArchiveDeletion(archived.id, actor)).delete_after).toBe(scheduled.delete_after);
    expect((await retention.purgeDueArchive(archived.id)).deleted).toBe(false);
    expect(await sql`select id from vehicles where id=1`).toHaveLength(1);
    expect((await retention.sweepArchiveRetention()).checked).toBe(0);
  });
  test("database constraint rejects an early deadline or incomplete schedule", async () => {
    const archived = await lifecycle.change("vehicles", 1, 1, "archive", actor);
    await retention.scheduleArchiveDeletion(archived.id, actor);
    await rejected(async () => { await sql`update archives set delete_after=deletion_requested_at + 2591999 where id=${archived.id}`; });
    await rejected(async () => { await sql`update archives set deletion_requested_at=null where id=${archived.id}`; });
    expect((await retention.purgeDueArchive(archived.id)).deleted).toBe(false);
  });
  test("restoring cancels pending deletion, including overdue schedules", async () => {
    const archive = await due("vehicles");
    await archiveService.restoreArchive(archive.id, actor);
    expect((await retention.purgeDueArchive(archive.id)).deleted).toBe(false);
    expect((await sql`select is_archived,is_active from vehicles where id=1`)[0]).toMatchObject({ is_archived: false, is_active: false });
    expect(await sql`select id from archives`).toHaveLength(0);
  });
  for (const resource of ["vehicles", "inventory", "products", "warehouses", "users"] as const) {
    test(`${resource}: cleanup automatically deletes an eligible record and only its safe owned children`, async () => {
      if (resource === "products" || resource === "warehouses") await sql`delete from inventory`;
      if (resource === "warehouses") await sql`delete from vehicles`;
      const id = resource === "users" ? 2 : 1;
      await due(resource, id);
      const result = await retention.sweepArchiveRetention();
      expect(result.deleted).toBe(1);
      expect(await sql.unsafe(`select id from ${resource} where id=$1`, [id])).toHaveLength(0);
      expect(await sql`select id from archives`).toHaveLength(0);
      expect(await sql`select id from audit_logs where action='ARCHIVE_PERMANENTLY_DELETED'`).toHaveLength(1);
      if (resource === "products") expect(await sql`select * from product_variants`).toHaveLength(0);
      if (resource === "users") {
        expect(await sql`select * from customers`).toHaveLength(0);
        expect(await sql`select * from customer_addresses`).toHaveLength(0);
      }
    });
  }
  test("delivery history blocks vehicle deletion despite its CASCADE foreign key", async () => {
    await sql`insert into deliveries(driver_id,vehicle_id,scheduled_date,departure_time,status) values (3,1,'2026-01-01','08:00','completed')`;
    const archived = await due("vehicles");
    expect((await retention.sweepArchiveRetention()).deleted).toBe(0);
    expect(await sql`select id from deliveries`).toHaveLength(1);
    expect(await sql`select id from vehicles`).toHaveLength(1);
    expect((await sql`select deletion_error from archives where id=${archived.id}`)[0].deletion_error).toContain("delivery history");
  });
  test("non-zero stock is retained; blocked entries do not stop cleanup of independent records", async () => {
    await sql`update inventory set quantity=5 where id=1`;
    const stock = await due("inventory");
    await due("vehicles");
    expect((await retention.sweepArchiveRetention()).deleted).toBe(1);
    expect((await sql`select quantity from inventory where id=1`)[0].quantity).toBe(5);
    expect((await sql`select deletion_error from archives where id=${stock.id}`)[0].deletion_error).toContain("stock");
  });
  test("product and owned variant references protect inventory and order history", async () => {
    const archived = await due("products");
    expect((await retention.purgeDueArchive(archived.id)).deleted).toBe(false);
    expect(await sql`select id from inventory`).toHaveLength(1);
    expect(await sql`select id from product_variants`).toHaveLength(1);
    expect((await sql`select deletion_error from archives where id=${archived.id}`)[0].deletion_error).toContain("inventory");
  });
  test("new foreign keys are discovered automatically and cannot cascade away data", async () => {
    await sql`delete from inventory`;
    await sql`create table fixture_dependency(id int primary key, product_id int references products(id) on delete cascade)`;
    try {
      await sql`insert into fixture_dependency values(1,1)`;
      const archived = await due("products");
      expect((await retention.purgeDueArchive(archived.id)).deleted).toBe(false);
      expect(await sql`select id from fixture_dependency`).toHaveLength(1);
    } finally { await sql`drop table fixture_dependency`; }
    expect((await retention.sweepArchiveRetention()).deleted).toBe(1);
  });
  test("concurrent workers and restoration produce one consistent outcome", async () => {
    const archived = await due("vehicles");
    await Promise.allSettled([retention.purgeDueArchive(archived.id), archiveService.restoreArchive(archived.id, actor), retention.purgeDueArchive(archived.id)]);
    expect(await sql`select id from archives`).toHaveLength(0);
    const rows = await sql`select is_archived from vehicles where id=1`;
    if (rows.length) expect(rows[0].is_archived).toBe(false);
    expect((await retention.purgeDueArchive(archived.id)).deleted).toBe(false);
    expect((await sql`select id from audit_logs where action='ARCHIVE_PERMANENTLY_DELETED'`).length).toBeLessThanOrEqual(1);
  });
  test("worker startup sweeps overdue records without waiting for the next interval", async () => {
    await due("vehicles");
    const worker = retention.startArchiveRetentionWorker();
    await worker.stop();
    expect(await sql`select id from vehicles`).toHaveLength(0);
  });
  test("archived Delete API requires an administrator and only schedules; direct entity deletes are disabled", async () => {
    const archive = await lifecycle.change("vehicles", 1, 1, "archive", actor);
    const { Elysia } = require("elysia");
    const { archivesRoutes } = require("../src/modules/archives");
    const app = (id: number) => new Elysia().onError(({ error, set }: any) => { set.status = error.status ?? 500; return { message: error.message }; })
      .resolve(() => ({ user: { sub: String(id), token_version: 0 } })).use(archivesRoutes);
    const request = () => new Request(`http://localhost/archives/${archive.id}`, { method: "DELETE" });
    expect((await app(2).handle(request())).status).toBe(403);
    const response = await app(1).handle(request());
    expect(response.status).toBe(202);
    expect((await response.json()).delete_after).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(await sql`select id from vehicles`).toHaveLength(1);
    await rejected(() => require("../src/modules/products/service").ProductService.deleteProductById(1, 1), "Archive");
    await rejected(() => require("../src/modules/inventory/service").InventoryService.deleteInventory(1, 1), "Archive");
    await rejected(() => require("../src/modules/warehouse/service").WarehouseService.deleteWarehouse(1, 1), "Archive");
    await rejected(() => require("../src/modules/vehicles/service").VehicleService.deleteVehicle(1, 1), "Archive");
  });
  test("vehicle API omits image and forces Available when status is omitted or supplied by a stale client", async () => {
    const { Elysia } = require("elysia");
    const { vehicleRoutes } = require("../src/modules/vehicles");
    const app = new Elysia().use(vehicleRoutes);
    for (const status of [undefined, "maintenance"]) {
      const response = await app.handle(new Request("http://localhost/vehicles", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ warehouse_id: 1, plate_number: `NEW-${status ?? "DEFAULT"}`, type: "van", ...(status ? { status } : {}) }) }));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.vehicle.status).toBe("available");
      expect(body.vehicle.image).toBeUndefined();
    }
    expect(await sql`select column_name from information_schema.columns where table_schema='public' and table_name='vehicles' and column_name='image'`).toHaveLength(0);
  });
});
