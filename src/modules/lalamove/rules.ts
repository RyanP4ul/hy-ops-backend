import { createHash } from "node:crypto";
import { WorkflowError } from "../../utils/workflow-error";
export const terminalStatuses = new Set(["CANCELED", "REJECTED", "EXPIRED"]);
export function fingerprint(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
export function safeTrackingLink(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["share.lalamove.com", "share.sandbox.lalamove.com"].includes(url.hostname) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
export function internationalPhone(value: string | null) {
  let phone = (value ?? "").replace(/[\s()-]/g, "");
  if (/^09\d{9}$/.test(phone)) phone = `+63${phone.slice(1)}`;
  if (!/^\+[1-9]\d{6,14}$/.test(phone)) throw new WorkflowError("A valid international pickup and recipient phone number is required.", 400);
  return phone;
}
export function assertReady(order: { status: string; delivery_method: string | null; stock_reserved: boolean; payment_arrangement: string | null }) {
  if (order.delivery_method !== "LALAMOVE") throw new WorkflowError("Select Lalamove as this order's delivery method first.");
  if (order.status !== "SCHEDULING" || !order.stock_reserved) throw new WorkflowError("Order must be ready for scheduling with reserved stock.");
  const allowed = (process.env.LALAMOVE_PAYMENT_ARRANGEMENTS ?? "FULLY_PAID,NET_30").split(",");
  if (order.payment_arrangement === "PAY_ON_DELIVERY" || !allowed.includes(order.payment_arrangement ?? ""))
    throw new WorkflowError("This payment arrangement is not approved for Lalamove. No merchandise cash collection is configured.");
}
