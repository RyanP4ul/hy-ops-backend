export type SessionClaims = { sub?: unknown; role?: unknown; token_version?: unknown; exp?: unknown; token_type?: unknown };
export type SessionActor = { id: number; role: string; token_version: number };

export function currentSession(claims: SessionClaims, actor: SessionActor | null | undefined, now = Math.floor(Date.now() / 1000)) {
  return !!actor && Number(claims.sub) === actor.id && claims.role === actor.role
    && claims.token_version === actor.token_version && claims.token_type === "access"
    && typeof claims.exp === "number" && Number.isFinite(claims.exp) && claims.exp > now;
}

export async function authorizeSession(token: unknown, verify: (token: string) => Promise<false | SessionClaims>, lookup: (id: number) => Promise<SessionActor | null | undefined>, method: string, path: string): Promise<200 | 401 | 403> {
  if (typeof token !== "string" || !token) return 401;
  const claims = await verify(token);
  if (!claims) return 401;
  const id = Number(claims.sub);
  const actor = Number.isSafeInteger(id) && id > 0 ? await lookup(id) : undefined;
  if (!actor || !currentSession(claims, actor)) return 401;
  return mayAccess(actor.role, method, path) ? 200 : 403;
}

export function allowedOrigin(origin: string | null, requestUrl: string): boolean {
  if (!origin) return true; // Native/mobile clients do not send browser Origin.
  const configured = (process.env.APP_ORIGINS ?? "http://localhost:3000,http://127.0.0.1:3000").split(",").map((value) => value.trim());
  return origin === new URL(requestUrl).origin || configured.includes(origin);
}

const staffResources = new Set(["dashboard", "products", "product_variants", "inventory", "warehouses", "orders", "invoice", "deliveries", "vehicles", "fleet", "reports", "geocode", "geocoding", "delivery-estimates", "delivery-schedules", "sms", "lalamove"]);
export const operationalSettings = new Set(["low_stock_threshold", "high_stock_threshold", "refresh_interval_ms", "is_form_validation_debug_enabled", "order_limit_per_day", "customer_order_limit", "max_order_per_vehicle", "returning_automatic_confirm_ms_interval", "mobile_automatic_refresh_interval_ms"]);

/** Fail closed. Lookup exceptions support the existing staff order/delivery forms. */
export function mayAccess(role: string, method: string, pathname: string): boolean {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (role === "admin") return true;
  if (!["staff", "driver", "customer"].includes(role)) return false;
  if (path === "/ws" || (method === "GET" && path === "/notifications") || (method === "POST" && path === "/notifications/mark-all-read")) return true;
  if (role === "driver") return (method === "POST" && /^\/driver\/returns\/\d+\/collected$/.test(path)) || (method === "POST" && /^\/driver\/trips\/\d+\/start$/.test(path)) ||     ((method === "GET" || method === "POST") && /^\/driver\/stops\/\d+\/proofs$/.test(path)) ||
    (method === "GET" && /^\/driver\/stops\/\d+\/proofs\/[0-9a-f-]{36}$/i.test(path)) || (method === "GET" && /^\/driver\/(profile|settings|trips(?:\/\d+)?|history)$/.test(path)) || (method === "POST" && /^\/driver\/stops\/\d+\/(delivered|failed)$/.test(path));
  if (role !== "staff") return false;
  if (method === "GET" && ["/users/customers", "/users/drivers", "/settings", "/settings/names"].includes(path)) return true;
  if (path.startsWith("/email/")) return method === "POST" && path === "/email/send";
  // Staff scheduling is constrained to the staff warehouse in route/service checks.
  if (path.startsWith("/inventory/reconciliation") || path.endsWith("/reconcile")) return false;
  return staffResources.has(path.split("/")[1]);
}
