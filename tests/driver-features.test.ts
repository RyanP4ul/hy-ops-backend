import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { historyBounds } from "../src/modules/driver/history-filter";

test("history boundaries use inclusive Manila dates and reject invalid calendar dates", () => {
  expect(historyBounds({ from: "2026-11-01", to: "2026-11-01" })).toEqual({ start: "2026-10-31T16:00:00.000Z", end: "2026-11-01T16:00:00.000Z" });
  expect(() => historyBounds({ from: "2026-02-30" })).toThrow();
  expect(() => historyBounds({ from: "2026-11-02", to: "2026-11-01" })).toThrow();
});

const url = process.env.HYOPS_TEST_DATABASE_URL;
describe.skipIf(!url)("driver history and private proof integration", () => {
  let sql: any, app: ReturnType<typeof import("../src/app").createApp>;
  let proofs: import("../src/modules/driver/proofs").ProofService;
  const objects = new Map<string, Uint8Array>();
  beforeAll(async () => {
    require("./live/environment").fixtureEnvironment();
    sql = require("postgres").default(url, { onnotice: () => {} });
    const { ProofService } = require("../src/modules/driver/proofs");
    proofs = new ProofService({
      async put(key: string, bytes: Uint8Array) { objects.set(key, bytes); },
      async get(key: string) { const bytes = objects.get(key); if (!bytes) throw new Error("missing"); return bytes; },
      async delete(key: string) { objects.delete(key); },
    });
    app = require("../src/app").createApp({ automation: false, externalIntegrations: false, proofs });
  });
  beforeEach(async () => { objects.clear(); await require("./driver-fixture").seedDriverFixture(sql); });
  afterAll(async () => { await sql?.end({ timeout: 2 }); await require("../src/db").db.$client.end({ timeout: 2 }); });

  async function run() {
    const result = await require("../src/modules/deliveries/service").DeliveryService.createDelivery({ order_ids: [1], driver_id: 3, vehicle_id: 1, scheduled_date: "2099-01-01", scheduled_time: "10:00", delivery_type: "INTERNAL", delivery_allowance: 0, fuel: 0, toll: 0 }, 1);
    await require("../src/modules/deliveries/service").DeliveryService.dispatchDelivery(result.id, 1);
    const [stop] = await sql`select id from deliveries_stops where delivery_id=${result.id}`;
    return { id: result.id, stopId: stop.id };
  }
  async function auth(email = "driver1@example.test") {
    const response = await app.handle(new Request("http://localhost/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "fixture-password", is_mobile: email.startsWith("driver") }) }));
    expect(response.status).toBe(200); const token = await response.json(); return `access_token=${token.access_token}`;
  }
  test("date/status filtering uses the same predicate for rows/count and does not expose other assignments", async () => {
    const { stopId } = await run();
    await sql`update deliveries_stops set status='delivered',delivered_at='2026-11-01T15:59:59Z',updated_at='2026-11-01T15:59:59Z' where id=${stopId}`;
    const cookie = await auth();
    const get = (query: string) => app.handle(new Request(`http://localhost/driver/history?${query}`, { headers: { cookie } }));
    const result = await (await get("from=2026-11-01&to=2026-11-01&status=delivered&pageSize=1")).json();
    expect(result.total).toBe(1); expect(result.items).toHaveLength(1);
    expect((await (await get("from=2026-11-02&status=delivered")).json()).total).toBe(0);
    expect((await (await get("status=failed")).json()).total).toBe(0);
    expect((await get("from=2026-11-02&to=2026-11-01")).status).toBe(400);
    const other = await auth("driver2@example.test");
    expect((await (await app.handle(new Request("http://localhost/driver/history", { headers: { cookie: other } }))).json()).total).toBe(0);
  });
  test("cancellation history filters on cancellation time rather than original schedule/stop creation", async () => {
    const result = await require("../src/modules/deliveries/service").DeliveryService.createDelivery({ order_ids: [1], driver_id: 3, vehicle_id: 1, scheduled_date: "2099-01-01", scheduled_time: "10:00", delivery_type: "INTERNAL", delivery_allowance: 0, fuel: 0, toll: 0 }, 1);
    await sql`update deliveries_stops set updated_at='2026-01-01T00:00:00Z' where delivery_id=${result.id}`;
    await sql`update deliveries set status='cancelled',updated_at='2026-11-01T00:00:00Z' where id=${result.id}`;
    const history = await require("../src/modules/driver/service").DriverService.history(3, 0, 20, { from: "2026-11-01", to: "2026-11-01", status: "cancelled" });
    expect(history.total).toBe(1); expect(history.items[0].status).toBe("cancelled");
  });
  test("assigned driver starts only today after departure; transition consumes stock once and replays safely", async () => {
    const delivery = require("../src/modules/deliveries/service").DeliveryService;
    const created = await delivery.createDelivery({ order_ids: [1], driver_id: 3, vehicle_id: 1, scheduled_date: "2099-01-01", scheduled_time: "10:00", delivery_type: "INTERNAL", delivery_allowance: 0, fuel: 0, toll: 0 }, 1);
    const cookie = await auth(), other = await auth("driver2@example.test");
    const start = (credential = cookie, version = 1) => app.handle(new Request(`http://localhost/driver/trips/${created.id}/start`, { method: "POST", headers: { cookie: credential, "content-type": "application/json" }, body: JSON.stringify({ version }) }));
    expect((await start()).status).toBe(409);
    expect((await start(other)).status).toBe(404);
    const today = require("../src/utils/time").todayInManila();
    await sql`update deliveries set scheduled_date='2000-01-01',departure_time='00:00' where id=${created.id}`;
    expect((await start()).status).toBe(409);
    await sql`update deliveries set scheduled_date=${today},departure_time='23:59:59' where id=${created.id}`;
    expect((await start()).status).toBe(409);
    await sql`update deliveries set scheduled_date=${today},departure_time='00:00' where id=${created.id}`;
    expect((await start(cookie, 99)).status).toBe(409);
    expect((await start()).status).toBe(200);
    expect((await sql`select status from deliveries where id=${created.id}`)[0].status).toBe("in_transit");
    expect((await sql`select status from orders where id=1`)[0].status).toBe("IN_TRANSIT");
    expect((await sql`select status from vehicles where id=1`)[0].status).toBe("on_delivery");
    const [stock] = await sql`select quantity from inventory where id=1`;
    expect((await start()).status).toBe(200);
    expect((await sql`select quantity from inventory where id=1`)[0].quantity).toBe(stock.quantity);
    expect((await start(other)).status).toBe(404);
  });
  test("photo/signature upload is private, idempotent, validated, bounded, and downloadable only by authorized actors", async () => {
    const { stopId } = await run(); const cookie = await auth();
    const sharp = require("sharp");
    const image = await sharp({ create: { width: 64, height: 32, channels: 3, background: "white" } }).png().toBuffer();
    const key = crypto.randomUUID();
    async function upload(auth: string, operationKey = key, kind = "photo", bytes = image) {
      const body = new FormData(); body.set("file", new File([bytes], "proof.png", { type: "image/png" })); body.set("kind", kind); body.set("operationKey", operationKey);
      return app.handle(new Request(`http://localhost/driver/stops/${stopId}/proofs`, { method: "POST", headers: { cookie: auth }, body }));
    }
    const saved = await upload(cookie); expect(saved.status).toBe(200); const proof = await saved.json();
    expect((await (await upload(cookie)).json()).id).toBe(proof.id);
    expect(objects.size).toBe(1);
    const bytes = await app.handle(new Request(`http://localhost/driver/stops/${stopId}/proofs/${proof.id}`, { headers: { cookie } }));
    expect(bytes.status).toBe(200); expect(bytes.headers.get("content-type")).toBe("image/webp"); expect((await bytes.arrayBuffer()).byteLength).toBeGreaterThan(0);
    const other = await auth("driver2@example.test");
    expect((await upload(other)).status).toBe(404);
    expect((await app.handle(new Request(`http://localhost/driver/stops/${stopId}/proofs/${proof.id}`, { headers: { cookie: other } }))).status).toBe(404);
    expect((await upload(cookie, crypto.randomUUID(), "photo", Buffer.from("not an image"))).status).toBe(400);
    expect((await upload(cookie, crypto.randomUUID(), "signature")).status).toBe(200);
    expect((await upload(cookie, crypto.randomUUID(), "signature")).status).toBe(409);
    expect((await proofs.list({ sub: 2, role: "staff" }, stopId)).length).toBe(2);
  });
});
