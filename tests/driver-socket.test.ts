import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const url = process.env.HYOPS_TEST_DATABASE_URL;
describe.skipIf(!url)("driver WebSocket integration", () => {
  let database: any;
  let app: ReturnType<typeof import("../src/app").createApp>;
  const sockets: WebSocket[] = [];
  beforeAll(async () => {
    require("./live/environment").fixtureEnvironment();
    process.env.GOOGLE_REFRESH_TOKEN = "fixture";
    database = require("postgres").default(url, { onnotice: () => {} });
    await require("./driver-fixture").seedDriverFixture(database);
    const delivery = require("../src/modules/deliveries/service").DeliveryService;
    const run = await delivery.createDelivery({ order_ids: [1], driver_id: 3, vehicle_id: 1,
      scheduled_date: "2099-01-01", scheduled_time: "10:00", delivery_type: "INTERNAL",
      delivery_allowance: 0, fuel: 0, toll: 0 }, 1);
    await delivery.dispatchDelivery(run.id, 1);
    app = require("../src/app").createApp({ automation: false, externalIntegrations: false }).listen({ port: 0, hostname: "127.0.0.1" });
  });
  afterAll(async () => {
    for (const session of require("../src/ws/socket-manager").socketManager.getSockets().values()) session.ws.raw.terminate();
    for (const socket of sockets) { if (socket.readyState !== WebSocket.CLOSED) socket.close(); }
    const deadline = Date.now() + 2000;
    while (sockets.some(socket => socket.readyState !== WebSocket.CLOSED) && Date.now() < deadline) await Bun.sleep(10);
    // Bun can leave stop()'s promise pending after a revoked WebSocket closes.
    // Force-stop/unref this owned listener, then explicitly await its lifecycle
    // workers rather than leaving PostgreSQL LISTEN connections running.
    app.server?.unref();
    void app.server?.stop(true);
    for (const hook of app.event.stop ?? []) await hook.fn(app);
    await database?.end({ timeout: 2 });
    await require("../src/db").db.$client.end({ timeout: 2 });
  });
  async function login(email: string, mobile: boolean) {
    const response = await app.handle(new Request("http://localhost/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "fixture-password", is_mobile: mobile }) }));
    expect(response.status).toBe(200);
    const data = await response.json();
    return `access_token=${data.access_token}; refresh_token=${data.refresh_token}`;
  }
  async function connect(cookie: string, ticket?: string) {
    const server = app.server;
    if (!server) throw new Error("Socket fixture is not listening.");
    const NativeSocket = WebSocket as unknown as new (url: string, options: Bun.WebSocketOptions) => WebSocket;
    const suffix = ticket ? `?ticket=${encodeURIComponent(ticket)}` : "";
    const socket = new NativeSocket(`ws://127.0.0.1:${server.port}/ws${suffix}`, { headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: "http://127.0.0.1:3100" } });
    sockets.push(socket);
    const messages: any[] = [];
    socket.addEventListener("message", event => messages.push(JSON.parse(String(event.data))));
    await waitFor(() => messages.some(m => m.type === "WS_READY"));
    return { socket, messages };
  }
  async function waitFor(predicate: () => boolean) {
    const deadline = Date.now() + 5000;
    while (!predicate() && Date.now() < deadline) await Bun.sleep(20);
    expect(predicate()).toBe(true);
  }
  async function ticketResponse(cookie?: string, origin = "http://127.0.0.1:3100") {
    return app.handle(new Request("http://localhost/auth/ws-ticket", {
      method: "POST", headers: { ...(cookie ? { Cookie: cookie } : {}), Origin: origin },
    }));
  }
  test("browser ticket upgrades without cookies; tickets are hashed, single use and expire", async () => {
    expect((await ticketResponse()).status).toBe(401);
    const cookie = await login("staff@example.test", false);
    expect((await ticketResponse(cookie, "https://untrusted.example")).status).toBe(403);
    const response = await ticketResponse(cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { ticket } = await response.json();
    const [stored] = await database`select ticket_hash, claims from ws_tickets`;
    expect(stored.ticket_hash).not.toBe(ticket);
    expect(stored.claims.role).toBe("staff");
    const browser = await connect("", ticket);
    expect(browser.messages.some(m => m.type === "WS_READY")).toBe(true);
    const probe = (value: string, origin = "http://127.0.0.1:3100") => app.handle(new Request(`http://localhost/ws?ticket=${value}`, { headers: { Origin: origin, Upgrade: "websocket" } }));
    expect((await probe(ticket)).status).toBe(401);
    expect((await probe("invalid")).status).toBe(401);
    const expired = await (await ticketResponse(cookie)).json();
    await database`update ws_tickets set expires_at=now()-interval '1 second'`;
    expect((await probe(expired.ticket)).status).toBe(401);
    const concurrent = await (await ticketResponse(cookie)).json();
    const { consumeWsTicket } = require("../src/modules/auth/ws-ticket");
    const redeemed = await Promise.all([consumeWsTicket(concurrent.ticket), consumeWsTicket(concurrent.ticket)]);
    expect(redeemed.filter(Boolean)).toHaveLength(1);
    const revoked = await (await ticketResponse(cookie)).json();
    await database`update users set token_version=token_version+1 where id=2`;
    expect((await probe(revoked.ticket)).status).toBe(401);
    expect((await ticketResponse(cookie)).status).toBe(401);
    expect((await app.handle(new Request("http://localhost/ws", { headers: { Upgrade: "websocket" } }))).status).toBe(401);
  });
  test("native cookie upgrade ingests real assigned GPS, rejects another driver, and invalidates website views", async () => {
    const driver = await connect(await login("driver1@example.test", true));
    const staff = await connect(await login("staff@example.test", false));
    staff.socket.send(JSON.stringify({ type: "CHANGE_PAGE", payload: ["fleet-map"] }));
    await Bun.sleep(100);
    const [run] = await database`select id,vehicle_id from deliveries where driver_id=3 and status in ('in_transit','returning') limit 1`;
    driver.socket.send(JSON.stringify({ type: "DRIVER_LOCATION_UPDATE", payload: [String(run.id), 14.59, 121.01, 10, 5, 90, new Date().toISOString()] }));
    await waitFor(() => staff.messages.some(m => m.type === "DRIVER_LOCATION_UPDATE"));
    const [position] = await database`select latitude,speed_kph from vehicle_positions where vehicle_id=${run.vehicle_id}`;
    expect(position).toMatchObject({ latitude: 14.59, speed_kph: 18 });
    const other = await connect(await login("driver2@example.test", true));
    other.socket.send(JSON.stringify({ type: "DRIVER_LOCATION_UPDATE", payload: [String(run.id), 10, 100, 10, 5, 90, new Date().toISOString()] }));
    await waitFor(() => other.messages.some(m => m.type === "WS_ERROR") || other.socket.readyState === WebSocket.CLOSED);
    expect((await database`select latitude from vehicle_positions where vehicle_id=${run.vehicle_id}`)[0].latitude).toBe(14.59);
    const admin = await connect(await login("admin@example.test", false));
    admin.socket.send(JSON.stringify({ type: "CHANGE_PAGE", payload: ["fleet-map"] }));
    await Bun.sleep(50);
    // A signed-in driver without an active run still shares live driver coordinates.
    other.socket.send(JSON.stringify({ type: "DRIVER_LOCATION_UPDATE", payload: [null, 14.61, 121.02, 5, 0, 90, new Date().toISOString()] }));
    await waitFor(() => admin.messages.some(m => m.type === "DRIVER_LOCATION_UPDATE" && m.payload.driver_id === 4));
    const idle = admin.messages.find(m => m.type === "DRIVER_LOCATION_UPDATE" && m.payload.driver_id === 4);
    expect(idle.payload.delivery_id).toBeNull(); expect(idle.payload.vehicle_id).toBeNull();
    expect((await database`select latitude from vehicle_positions where vehicle_id=${run.vehicle_id}`)[0].latitude).toBe(14.59);
    await database`update users set token_version=token_version+1,refresh_token=null where id=4`;
    const idleCount = admin.messages.filter(m => m.type === "DRIVER_LOCATION_UPDATE" && m.payload.driver_id === 4).length;
    other.socket.send(JSON.stringify({ type: "DRIVER_LOCATION_UPDATE", payload: [null, 14.62, 121.03, 5, 0, 90, new Date().toISOString()] }));
    await Bun.sleep(150);
    expect(admin.messages.filter(m => m.type === "DRIVER_LOCATION_UPDATE" && m.payload.driver_id === 4)).toHaveLength(idleCount);
    expect(staff.messages.some(m => m.type === "DRIVER_LOCATION_UPDATE" && m.payload.driver_id === 4)).toBe(false);
    // A second API instance's notification reaches the website subscriber via PostgreSQL.
    const marker = crypto.randomUUID();
    await database.notify("hyops_resource_changed", JSON.stringify({ type: "RESOURCE_CHANGED", payload: { resource: "deliveries", eventId: marker } }));
    await waitFor(() => staff.messages.some(m => m.type === "RESOURCE_CHANGED" && m.payload.eventId === marker));
    expect(driver.messages.some(m => m.type === "RESOURCE_CHANGED")).toBe(false);
    await database`update deliveries set departure_time='11:00' where id=${run.id}`;
    await waitFor(() => driver.messages.some(m => m.type === "DRIVER_ASSIGNMENT_CHANGED"));
    expect(other.messages.some(m => m.type === "DRIVER_ASSIGNMENT_CHANGED")).toBe(false);
    const event = driver.messages.find(m => m.type === "DRIVER_ASSIGNMENT_CHANGED");
    expect(event.payload.driverId).toBe(3);
    expect(event.payload.deliveryId).toBe(run.id);
    expect(Object.keys(event.payload).sort()).toEqual(["deliveryId", "driverId", "eventId", "kind"]);
    const count = driver.messages.filter(m => m.type === "DRIVER_ASSIGNMENT_CHANGED").length;
    try { await database.begin(async (tx: any) => { await tx`update deliveries set departure_time='12:00' where id=${run.id}`; throw new Error("Rollback fixture"); }); } catch { /* Expected rollback. */ }
    await Bun.sleep(100);
    expect(driver.messages.filter(m => m.type === "DRIVER_ASSIGNMENT_CHANGED")).toHaveLength(count);
    // A customer pickup attached to the same run reaches only its assigned driver.
    const [stop] = await database`select id from deliveries_stops where delivery_id=${run.id}`;
    const service = require("../src/modules/driver/service").DriverService;
    const trip = await service.trip(3, run.id);
    await service.outcome(3, stop.id, { version: trip.version, operationKey: crypto.randomUUID() }, "delivered");
    const returns = require("../src/modules/deliveries/customer-returns").CustomerReturnService;
    const task = await returns.request({ sub: "2", role: "staff" }, stop.id, { reason: "Return fixture", operationKey: crypto.randomUUID() });
    await Bun.sleep(100);
    const beforePickup = driver.messages.filter(m => m.type === "DRIVER_ASSIGNMENT_CHANGED").length;
    await returns.assign({ sub: "2", role: "staff" }, task.id, { version: 1, vehicleId: run.vehicle_id, driverId: 3, operationKey: crypto.randomUUID() });
    await waitFor(() => driver.messages.filter(m => m.type === "DRIVER_ASSIGNMENT_CHANGED").length > beforePickup);
    expect(other.messages.some(m => m.type === "DRIVER_ASSIGNMENT_CHANGED")).toBe(false);


  });
});
