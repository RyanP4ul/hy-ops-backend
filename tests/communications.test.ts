import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SmsGateway, templateVariables } from "../src/modules/sms/service";
import { buildEmailMessage } from "../src/modules/email/message";

const stats = { success: true as const, overall: { total: 3, pending: 0, processing: 0, sent: 3, delivered: 0, failed: 0, cancelled: 0 }, today: { total: 0, sent: 0, failed: 0 }, weekly_trend: [{ date: "2026-10-30", total: 3, sent: 3, failed: 0 }], per_device: [{ device_id: "fixture-active", device_name: "Fixture phone", is_active: true, last_seen: "2026-10-30T22:56:40.425Z", total_sms: 3, sent: 3, failed: 0 }, { device_id: "fixture-inactive", device_name: "Offline phone", is_active: false, last_seen: null, total_sms: 0, sent: 0, failed: 0 }], active_devices: 1 };
const templates = { success: true as const, templates: [{ id: 1, name: "Greeting", content: "Hi {{name}} / {{order}}", variables: ["name", "order"], is_active: true, usage_count: 0, created_at: "2026-11-02T01:45:40.092Z" }, { id: 2, name: "Inactive", content: "Hi", variables: [], is_active: false, usage_count: 0, created_at: "2026-11-02T01:45:40.092Z" }] };
const command = { device_id: "fixture-active", phone_number: "09123456789", template_id: 1, variables: { name: "Customer", order: "ORDER-1" } };
function gatewayFixture() {
  let mode = "ok";
  const calls: { path: string; init: RequestInit }[] = [];
  const transport = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname; calls.push({ path, init });
    if (mode === "http") return Response.json({ success: false, token: "must-not-leak" }, { status: 401 });
    if (mode === "invalid") return new Response("not-json", { status: 200 });
    if (mode === "false") return Response.json({ success: false, message: "must-not-leak" });
    if (mode === "network") throw new Error("must-not-leak");
    if (path === "/api/stats") return Response.json({ ...stats, admin_key: "must-not-leak" });
    if (path === "/api/templates") return Response.json(templates);
    if (path === "/api/sms/send" && mode === "send-network") throw new Error("Unknown provider acknowledgement");
    if (path === "/api/sms/send" && mode === "send-false") return Response.json({ success: false });
    if (path === "/api/sms/send") return Response.json({ success: true, id: "sms-1", admin_key: "must-not-leak" });
    throw new Error(`Unexpected fixture route ${path}`);
  }) as unknown as typeof fetch;
  return { gateway: new SmsGateway(transport, { url: "https://gateway.example.test/api/", token: "fixture-admin-token" }), calls, setMode: (value: string) => { mode = value; } };
}
async function rejected(promise: Promise<unknown>) {
  let error: unknown;
  try { await promise; } catch (issue) { error = issue; }
  expect(error).toBeInstanceOf(Error);
  return error as Error & { status: number };
}
test("SMS stats/templates use backend-only token and confirmed send preserves gateway contract and leading zero", async () => {
  const fixture = gatewayFixture();
  expect(await fixture.gateway.stats()).toEqual(stats);
  expect(await fixture.gateway.templates()).toEqual(templates);
  const result = await fixture.gateway.send(command);
  expect(result).toMatchObject({ success: true, id: "sms-1" });
  const sends = fixture.calls.filter(call => call.init.method === "POST");
  expect(sends).toHaveLength(1); expect(sends[0].path).toBe("/api/sms/send");
  expect(JSON.parse(String(sends[0].init.body))).toEqual(command);
  expect(new Headers(sends[0].init.headers).get("x-admin-token")).toBe("fixture-admin-token");
  expect(JSON.stringify(result)).not.toContain("must-not-leak");
});
test("SMS validation blocks inactive device/template, missing variables and bad phone before any send", async () => {
  const fixture = gatewayFixture();
  for (const input of [{ ...command, device_id: "fixture-inactive" }, { ...command, template_id: 2 }, { ...command, variables: { name: "Customer" } }, { ...command, phone_number: "abc" }]) await rejected(fixture.gateway.send(input));
  expect(fixture.calls.filter(call => call.init.method === "POST")).toHaveLength(0);
  expect(templateVariables("{{name}} {{ order.id }} {{name}}", ["declared"])).toEqual(["declared", "name", "order.id"]);
});
test("SMS provider failures never return fake success, expose upstream details or retry sends", async () => {
  const fixture = gatewayFixture();
  for (const mode of ["http", "invalid", "false", "network"]) {
    fixture.setMode(mode);
    const error = await rejected(fixture.gateway.stats());
    expect(error.status).toBe(502); expect(error.message).not.toContain("must-not-leak");
  }
  expect((await rejected(new SmsGateway(fetch, { url: "", token: "" }).stats())).status).toBe(503);
});
test("ambiguous SMS POST results are not retried or reported delivered", async () => {
  for (const mode of ["send-network", "send-false"]) {
    const fixture = gatewayFixture(); fixture.setMode(mode);
    expect((await rejected(fixture.gateway.send(command))).status).toBe(502);
    expect(fixture.calls.filter(call => call.init.method === "POST")).toHaveLength(1);
  }
});
test("email MIME preserves UTF-8 plaintext and rejects extra headers", () => {
  const subject = "Delivery update " + "\u00f1\u2705".repeat(30), message = "Hello\n<script>plain text</script>\n\u00f1";
  const raw = Buffer.from(buildEmailMessage("customer@example.test", subject, message), "base64url").toString("utf8");
  const [headers, body] = raw.split("\r\n\r\n");
  const decodedSubject = Array.from(headers.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g), match => Buffer.from(match[1], "base64").toString("utf8")).join("");
  expect(decodedSubject).toBe(subject); expect(Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf8")).toBe(message);
  expect(raw).toContain("Content-Type: text/plain");
  expect(headers.split("\r\n").filter(line => line.startsWith("Subject:") || line.startsWith(" ")).every(line => line.length <= 78)).toBe(true);
  expect(() => buildEmailMessage("customer@example.test", "Hello\r\nBcc: other@example.test", "Message")).toThrow();
});

const testUrl = process.env.HYOPS_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("authenticated communications APIs with fake providers", () => {
  let sql: any, app: ReturnType<typeof import("../src/app").createApp>;
  let fixture = gatewayFixture(), emails: string[] = [], emailFails = false, emailEmpty = false;
  beforeAll(() => {
    if (!testUrl) throw new Error("Disposable fixture required");
    const url = new URL(testUrl);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/hyops_test") throw new Error("Disposable fixture required");
    require("./live/environment").fixtureEnvironment();
    sql = require("postgres").default(testUrl, { onnotice: () => {} });
  });
  beforeEach(async () => {
    await require("./driver-fixture").seedDriverFixture(sql);
    fixture = gatewayFixture(); emails = []; emailFails = false; emailEmpty = false;
    app = require("../src/app").createApp({ automation: false, externalIntegrations: true, sms: fixture.gateway, emailSender: async (raw: string) => { if (emailFails) throw new Error("private-provider-detail"); if (emailEmpty) return undefined; emails.push(raw); return "mail-1"; } });
  });
  afterAll(async () => { await sql?.end(); await require("../src/db").db.$client.end({ timeout: 2 }); });
  async function cookie(email: string) {
    const response = await app.handle(new Request("http://localhost/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "fixture-password", is_mobile: email.startsWith("driver") }) }));
    expect(response.status).toBe(200); const data = await response.json(); return `access_token=${data.access_token}; refresh_token=${data.refresh_token}`;
  }
  const send = (cookie: string, path: string, body?: object) => app.handle(new Request(`http://localhost${path}`, { method: body ? "POST" : "GET", headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  test("customer contacts search before pagination and exclude archived or missing contacts", async () => {
    await sql`insert into users(email,name,password_hash,role,is_archived,created_at,updated_at)
      select 'contact-' || n || '@example.test','Contact ' || n,'unused','customer',n=23,0,0 from generate_series(1,24) n`;
    await sql`insert into customers(user_id,company_name,phone_number)
      select id,'Directory',case when email='contact-24@example.test' then '' else '099000000' || lpad(split_part(split_part(email,'-',2),'@',1),2,'0') end from users where email like 'contact-%'`;
    const staff = await cookie("staff@example.test");
    const first = await (await send(staff, "/users/customers?contact=phone&search=Directory&page=0&limit=10")).json();
    const last = await (await send(staff, "/users/customers?contact=phone&search=Directory&page=2&limit=10")).json();
    expect(first.total).toBe(22); expect(first.rows).toHaveLength(10); expect(last.total).toBe(22); expect(last.rows).toHaveLength(2);
    expect(first.rows.some((row: { id: number }) => last.rows.some((item: { id: number }) => item.id === row.id))).toBe(false);
    const byPhone = await (await send(staff, "/users/customers?contact=phone&search=09900000022")).json();
    expect(byPhone.total).toBe(1); expect(byPhone.rows[0]).toMatchObject({ email: "contact-22@example.test", phone_number: "09900000022" });
    const byEmail = await (await send(staff, "/users/customers?contact=email&search=contact-24%40example.test")).json();
    expect(byEmail.total).toBe(1); expect(byEmail.rows[0].phone_number).toBe("");
    expect((await (await send(staff, "/users/customers?search=contact-23%40example.test")).json()).total).toBe(0);
  });
  test("staff can read gateway data and send one template SMS and email; drivers cannot", async () => {
    const staff = await cookie("staff@example.test"), driver = await cookie("driver1@example.test");
    expect((await send(staff, "/sms/stats")).status).toBe(200);
    expect((await send(staff, "/sms/templates")).status).toBe(200);
    expect((await send(staff, "/sms/send-sms", command)).status).toBe(200);
    expect((await send(driver, "/sms/send-sms", command)).status).toBe(403);
    const email = { to: "customer@example.test", subject: "Order update", message: "Your order is ready." };
    const response = await send(staff, "/email/send", email);
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ success: true, messageId: "mail-1" });
    expect((await send(driver, "/email/send", email)).status).toBe(403);
    expect(emails).toHaveLength(1); expect(fixture.calls.filter(call => call.init.method === "POST")).toHaveLength(1);
    expect((await send(staff, "/email/oauth/start")).status).toBe(403);
  });
  test("invalid commands and provider failures do not report successful delivery", async () => {
    const staff = await cookie("staff@example.test");
    expect((await send(staff, "/sms/send-sms", { ...command, variables: {} })).status).toBe(400);
    expect((await send(staff, "/email/send", { to: "customer@example.test", subject: "Hello\r\nBcc: other@example.test", message: "Message" })).status).toBe(400);
    emailFails = true;
    const result = await send(staff, "/email/send", { to: "customer@example.test", subject: "Hello", message: "Message" });
    expect(result.status).toBe(502); expect(await result.text()).not.toContain("private-provider-detail");
    emailFails = false; emailEmpty = true;
    expect((await send(staff, "/email/send", { to: "customer@example.test", subject: "Hello", message: "Message" })).status).toBe(502);
    fixture.setMode("http"); expect((await send(staff, "/sms/stats")).status).toBe(502);
    expect(fixture.calls.filter(call => call.init.method === "POST")).toHaveLength(0); expect(emails).toHaveLength(0);
  });
  test("integration disabled guard still prevents all external submission", async () => {
    const staff = await cookie("staff@example.test");
    app = require("../src/app").createApp({ automation: false, externalIntegrations: false, sms: fixture.gateway, emailSender: async () => { throw new Error("Must not send"); } });
    expect((await send(staff, "/sms/send-sms", command)).status).toBe(503);
    expect((await send(staff, "/email/send", { to: "customer@example.test", subject: "Hello", message: "Message" })).status).toBe(503);
    expect(fixture.calls).toHaveLength(0); expect(emails).toHaveLength(0);
  });
});
