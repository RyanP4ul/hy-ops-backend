import Elysia from "elysia";
import { db } from "../../db";
import { lalamove_events } from "../../db/schema/lalamove";
import { lalamoveConfig } from "../../plugins/lalamove";
import { fingerprint } from "./rules";
import { verifyLalamoveWebhook } from "./webhook-auth";
import { lalamoveCallback } from "./webhook-config";

export const lalamoveWebhookRoutes = new Elysia().post("/webhooks/lalamove", async ({ request, set }) => {
  const raw = await request.text();
  if (!raw.trim()) return { received: true }; // Registration probe has no side effects.
  if (raw.length > 262144) { set.status = 413; return { message: "Payload too large." }; }
  let value: unknown;
  try { value = JSON.parse(raw); } catch { set.status = 400; return { message: "Invalid JSON." }; }
  if (!verifyLalamoveWebhook(value, process.env.LALAMOVE_API_KEY ?? "", process.env.LALAMOVE_API_SECRET ?? "", lalamoveCallback().path)) {
    set.status = 401; return { message: "Invalid provider signature." };
  }
  if (value.eventVersion !== "v3") { set.status = 400; return { message: "Configure webhook event version v3." }; }
  const config = lalamoveConfig();
  const order = value.data.order as { orderId?: string } | undefined;
  // Deduplicate by signed data. Outer eventId/eventType are not part of the signature.
  await db.insert(lalamove_events).values({ environment: config.environment,
    dedupe_key: `${config.environment}:${config.market}:${fingerprint(value.data)}`,
    event_type: String(value.eventType).slice(0, 100), provider_order_id: typeof order?.orderId === "string" ? order.orderId : null,
    payload: value.data }).onConflictDoNothing();
  return { received: true };
}, { parse: "none" });
