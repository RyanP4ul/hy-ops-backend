import { timingSafeEqual } from "node:crypto";
import { signLalamove } from "../../plugins/lalamove";
export type LalamoveWebhook = { apiKey: string; timestamp: number | string; signature: string; eventType: string; eventVersion: string; data: Record<string, unknown> };
/** Provider signs JSON.stringify(data), not the outer envelope or raw HTTP body. */
export function verifyLalamoveWebhook(value: unknown, key: string, secret: string, path: string): value is LalamoveWebhook {
  if (!value || typeof value !== "object" || !key || !secret) return false;
  const body = value as LalamoveWebhook;
  if (body.apiKey !== key || !/^[a-f0-9]{64}$/.test(body.signature ?? "") || !/^\d+$/.test(String(body.timestamp)) || !body.data || typeof body.data !== "object" || Array.isArray(body.data)) return false;
  const expected = signLalamove(secret, String(body.timestamp), "POST", path, JSON.stringify(body.data));
  return timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(body.signature, "hex"));
}
