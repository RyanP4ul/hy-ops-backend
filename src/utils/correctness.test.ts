import { expect, test } from "bun:test";
import { moneyToMinorUnits, minorUnitsToMoney } from "./money";
import { canDriverStartTripAt, isScheduledTripOverdue, todayInManila } from "./time";
import { generateHyphenatedSku, isValidSku } from "../modules/products/sku";
import { auditTarget, redactAuditPayload } from "./audit";
import { canSendRequest, canSubscribe } from "../ws/authorization";
import { allowedOrigin, currentSession, mayAccess } from "../modules/auth/policy";
import { watchSession } from "../ws/session-watch";
import { SocketManager } from "../ws/socket-manager";
import { TOPIC } from "../ws/topic";
import { parseUserAgent } from "./headers";

test("centavo calculations are exact and reject malformed amounts", () => {
  expect(moneyToMinorUnits("12.34") * 3n - moneyToMinorUnits(5)).toBe(3202n);
  expect(minorUnitsToMoney(-1n)).toBe("-0.01");
  for (const value of ["", "1.234", "NaN", Infinity, NaN, "0x10"]) expect(() => moneyToMinorUnits(value)).toThrow();
});

test("overdue schedules and calendar days use Manila with at least 1-hour departure grace", () => {
  const now = Date.parse("2026-10-30T00:00:00Z"); // 08:00 Manila
  expect(isScheduledTripOverdue("2026-10-30", "06:59", now)).toBe(true); // 61m past departure -> overdue
  expect(isScheduledTripOverdue("2026-10-30", "07:00", now)).toBe(false); // exactly 60m past -> still inside 1h grace
  expect(isScheduledTripOverdue("2026-10-30", "07:59", now)).toBe(false); // 1m past -> still inside 1h grace
  expect(isScheduledTripOverdue("2026-10-30", "08:00", now)).toBe(false);
  expect(todayInManila(new Date("2026-10-29T16:00:00Z"))).toBe("2026-10-30");

  // Driver flexible 1-hour early start window
  expect(canDriverStartTripAt("2026-10-30", "09:01", now)).toBe(false); // 61m early -> blocked
  expect(canDriverStartTripAt("2026-10-30", "09:00", now)).toBe(true); // 60m early -> allowed
  expect(canDriverStartTripAt("2026-10-30", "08:30", now)).toBe(true); // 30m early -> allowed
  expect(canDriverStartTripAt("2026-10-30", "08:00", now)).toBe(true); // on time -> allowed
});

test("automated hyphenated SKU generator creates deterministic collision-safe SKUs", () => {
  expect(generateHyphenatedSku("Linoleum", ".32mm")).toBe("HY-LN-32MM");
  expect(generateHyphenatedSku("Tarpaulin", "S4")).toBe("HY-TP-S4");
  expect(generateHyphenatedSku("Linoleum", ".32mm", ["HY-LN-32MM"])).toBe("HY-LN-32MM-2");
  expect(isValidSku("HY-LN-32MM")).toBe(true);
  expect(isValidSku("HY-")).toBe(false);
});

test("audit targets identify subresource owners and redact nested credentials", () => {
  expect(auditTarget("/users/12/password")).toEqual({ entityType: "users", entityId: "12" });
  expect(auditTarget("/users/12/archive")).toEqual({ entityType: "users", entityId: "12" });
  expect(auditTarget("/orders/customers/7/addresses")).toEqual({ entityType: "customers", entityId: "7" });
  expect(redactAuditPayload({ password: "secret", profile: { access_token: "token", name: "Operator" } }))
    .toEqual({ password: "[REDACTED]", profile: { access_token: "[REDACTED]", name: "Operator" } });
});

test("live subscriptions and messages follow operational roles", () => {
  expect(canSubscribe("staff", "fleet-map")).toBe(true);
  for (const role of ["staff", "driver", "customer", "unknown"]) expect(canSubscribe(role, "users")).toBe(false);
  expect(canSubscribe("admin", "arbitrary-channel")).toBe(false);
  expect(canSubscribe("admin", "users")).toBe(true);
  expect(canSendRequest("staff", "USER_UPDATED")).toBe(false);
  expect(canSendRequest("customer", "ORDER_UPDATED")).toBe(false);
  expect(canSendRequest("driver", "DRIVER_LOCATION_UPDATE")).toBe(true);
  expect(canSendRequest("admin", "RESOURCE_CHANGED")).toBe(false);
  expect(canSendRequest("admin", "USER_HACK")).toBe(false);
  expect(canSendRequest("staff", "PRODUCT_HACK")).toBe(false);
  expect(canSendRequest("staff", "PRODUCT_UPDATED")).toBe(true);
});

test("REST permissions protect admin resources while keeping staff operational lookups", () => {
  for (const path of ["/users", "/payments", "/archives", "/sessions", "/audit-logs", "/automations", "/calendar"]) {
    expect(mayAccess("staff", "GET", path)).toBe(false);
    expect(mayAccess("admin", "GET", path)).toBe(true);
  }
  for (const path of ["/users/customers", "/users/drivers", "/settings", "/inventory", "/products"]) expect(mayAccess("staff", "GET", path)).toBe(true);
  expect(mayAccess("staff", "POST", "/deliveries")).toBe(true);
  expect(mayAccess("staff", "POST", "/inventory/reconciliation")).toBe(false);
  expect(mayAccess("staff", "POST", "/settings")).toBe(false);
  expect(mayAccess("customer", "GET", "/orders")).toBe(false);
  expect(mayAccess("driver", "GET", "/fleet")).toBe(false);
  expect(allowedOrigin("https://untrusted.example", "http://localhost:5173/users")).toBe(false);
  expect(allowedOrigin("http://localhost:3000", "http://localhost:5173/users")).toBe(true);
});

test("current sessions require signed expiry, current role/version and access token type", () => {
  const actor = { id: 1, role: "admin", token_version: 2 };
  const claims = { sub: "1", role: "admin", token_version: 2, token_type: "access", exp: 101 };
  expect(currentSession(claims, actor, 100)).toBe(true);
  expect(currentSession(claims, actor, 101)).toBe(false);
  expect(currentSession({ ...claims, token_type: "refresh" }, actor, 100)).toBe(false);
  expect(currentSession({ ...claims, token_version: 1 }, actor, 100)).toBe(false);
  expect(currentSession({ ...claims, role: "staff" }, actor, 100)).toBe(false);
});

test("idle sockets close after revocation, expiry, or a failed account lookup", async () => {
  const code = await new Promise<number>((resolve) => watchSession(Date.now() / 1000 + 60, async () => false, (code) => resolve(code), 5));
  expect(code).toBe(4001);
  const expired = await new Promise<number>((resolve) => watchSession(Date.now() / 1000 + 0.01, async () => true, (code) => resolve(code), 5));
  expect(expired).toBe(4002);
  const unavailable = await new Promise<number>((resolve) => watchSession(Date.now() / 1000 + 60, async () => { throw new Error("fixture"); }, (code) => resolve(code), 5));
  expect(unavailable).toBe(4003);
});

test("mobile sessions register on mobile page and session-and-logs broadcasts reach subscribed admins", () => {
  const manager = new SocketManager();
  const adminMessages: string[] = [];
  const staffMessages: string[] = [];
  const driverMessages: string[] = [];

  const makeWs = (id: string, topics: string[], sink: string[]) => ({
    id,
    isSubscribed: (topic: string) => topics.includes(topic),
    send: (data: string) => sink.push(data),
  });
  const baseUser = {
    email: "u@example.test",
    name: "User",
    token_version: 1,
    user_agent: parseUserAgent("HYOps-Driver/1.0 (Android; Flutter)"),
    iat: 1,
    exp: 9999999999,
    token_type: "access",
  };

  manager.addSocket(makeWs("admin-1", [TOPIC.SESSION_AND_LOGS], adminMessages), "127.0.0.1", { ...baseUser, sub: 1, role: "admin" });
  manager.getSocket("admin-1")!.page = TOPIC.SESSION_AND_LOGS;
  manager.addSocket(makeWs("staff-1", [TOPIC.SESSION_AND_LOGS], staffMessages), "127.0.0.1", { ...baseUser, sub: 2, role: "staff" });
  manager.addSocket(makeWs("driver-1", [], driverMessages), "127.0.0.1", { ...baseUser, sub: 3, role: "driver" });

  expect(manager.getSocket("driver-1")?.page).toBe("mobile");
  expect(manager.getSocket("staff-1")?.page).toBe("dashboard");

  manager.broadcastToTopic(
    TOPIC.SESSION_AND_LOGS,
    { type: "NEW_SESSION", payload: { id: "driver-1", page: "mobile" } },
    { excludeSocketId: "driver-1", allowedRoles: ["admin"] },
  );

  expect(adminMessages).toHaveLength(1);
  expect(JSON.parse(adminMessages[0])).toMatchObject({ type: "NEW_SESSION", payload: { id: "driver-1", page: "mobile" } });
  expect(staffMessages).toHaveLength(0);
  expect(driverMessages).toHaveLength(0);

  expect(parseUserAgent("HYOps-Driver/1.0 (Android; Flutter)")).toMatchObject({
    browser: { name: "HYOps Mobile App" },
    os: { name: "Android" },
    device: { type: "mobile" },
  });
  expect(parseUserAgent("HYOps-Driver/1.0 (iOS; Flutter)")).toMatchObject({
    browser: { name: "HYOps Mobile App" },
    os: { name: "iOS" },
    device: { type: "mobile" },
  });
});
