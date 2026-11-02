import { fixtureEnvironment } from "../live/environment";
import { createHmac } from "node:crypto";
fixtureEnvironment();

async function start() {
  const postgres = require("postgres").default;
  const database = postgres(process.env.HYOPS_TEST_DATABASE_URL, { onnotice: () => {} });
  await require("../driver-fixture").seedDriverFixture(database);
  const delivery = require("../../src/modules/deliveries/service").DeliveryService;
  const run = await delivery.createDelivery({ order_ids: [1], driver_id: 3, vehicle_id: 1, scheduled_date: "2099-01-01", scheduled_time: "10:00", delivery_type: "INTERNAL", delivery_allowance: 0, fuel: 0, toll: 0 }, 1);
  await database`insert into orders(order_number,warehouse_id,customer_id,status,payment_arrangement,shipping_address,shipping_latitude,shipping_longitude)
    select 'HISTORY-'||n,1,1,'COMPLETED','NET_30','Saved address',14.5,121.1 from generate_series(1,25) n`;
  await database`insert into order_items(order_id,inventory_id,quantity,unit_price_snapshot,price_source) select id,1,1,12.34,'fixture' from orders where order_number like 'HISTORY-%'`;
  const [historyRun] = await database`insert into deliveries(driver_id,vehicle_id,scheduled_date,departure_time,status) values(3,1,'2026-10-31','10:00','completed') returning id`;
  await database`insert into deliveries_stops(delivery_id,order_id,leg_index,status,latitude,longitude,delivered_at,updated_at)
    select ${historyRun.id},id,row_number() over(order by id)-1,'delivered',14.5,121.1,'2026-11-01T00:00:00Z','2026-11-01T00:00:00Z' from orders where order_number like 'HISTORY-%'`;
  const objects = new Map<string, Uint8Array>();
  const { ProofService } = require("../../src/modules/driver/proofs");
  const proofs = new ProofService({
    async put(key: string, value: Uint8Array) { objects.set(key, value); },
    async get(key: string) { const value = objects.get(key); if (!value) throw new Error("Missing fixture object"); return value; },
    async delete(key: string) { objects.delete(key); },
  });
  const { Elysia } = require("elysia");
  // This file is never imported by production. Bind only to loopback and require a fixture header.
  const fixture = new Elysia({ prefix: "/__test__" }).onBeforeHandle(({ request, set }: any) => {
    if (request.headers.get("x-hyops-fixture") !== "driver-device-checks") { set.status = 403; return "Fixture only"; }
  }).get("/ready", () => ({ ok: true }))
    .post("/revoke", async () => { await database`update users set token_version=token_version+1,refresh_token=null where id=3`; return { ok: true }; })
    .get("/expired-access", async () => {
      const [user] = await database`select id,email,name,role,token_version from users where id=3`;
      const value = [Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url"), Buffer.from(JSON.stringify({ sub: String(user.id), email: user.email, name: user.name, role: user.role, token_version: user.token_version, token_type: "access", iat: 1, exp: 2 })).toString("base64url")].join(".");
      return { token: `${value}.${createHmac("sha256", process.env.JWT_SECRET as string).update(value).digest("base64url")}` };
    }).get("/slow", async () => { await Bun.sleep(500); return { ok: true }; })
    .post("/dispatch", async () => delivery.dispatchDelivery(run.id, 1))
    .post("/assignment", async () => { await database`update deliveries set departure_time=case when departure_time='10:00' then '11:00'::time else '10:00'::time end where id=${run.id}`; return { ok: true }; });
  new Elysia().use(fixture).use(require("../../src/app").createApp({ automation: false, externalIntegrations: false, proofs })).listen({ port: 5192, hostname: "127.0.0.1" });
  console.log("Driver device fixture ready on loopback 5192");
}
start().catch(error => { console.error(error); process.exit(1); });
