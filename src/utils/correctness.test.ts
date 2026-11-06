import { expect, test } from "bun:test";
import { moneyToMinorUnits, minorUnitsToMoney } from "./money";
import { isScheduledTripOverdue, todayInManila } from "./time";
import { auditTarget, redactAuditPayload } from "./audit";
import { canSendRequest, canSubscribe } from "../ws/authorization";
import { allowedOrigin, currentSession, mayAccess } from "../modules/auth/policy";
import { watchSession } from "../ws/session-watch";

test("centavo calculations are exact and reject malformed amounts", () => {
  expect(moneyToMinorUnits("12.34") * 3n - moneyToMinorUnits(5)).toBe(3202n);
  expect(minorUnitsToMoney(-1n)).toBe("-0.01");
  for (const value of ["", "1.234", "NaN", Infinity, NaN, "0x10"]) expect(() => moneyToMinorUnits(value)).toThrow();
});

test("overdue schedules and calendar days use Manila", () => {
  const now = Date.parse("2026-10-30T00:00:00Z");
  expect(isScheduledTripOverdue("2026-10-30", "07:59", now)).toBe(true);
  expect(isScheduledTripOverdue("2026-10-30", "08:00", now)).toBe(false);
  expect(todayInManila(new Date("2026-10-29T16:00:00Z"))).toBe("2026-10-30");
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
