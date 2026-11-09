import { createHmac, randomUUID } from "node:crypto";
import { WorkflowError } from "../utils/workflow-error";

export function lalamoveConfig() {
  const base = (process.env.LALAMOVE_BASE_URL ?? "https://rest.sandbox.lalamove.com").replace(/\/$/, "");
  if (!["https://rest.sandbox.lalamove.com", "https://rest.lalamove.com"].includes(base))
    throw new WorkflowError("Lalamove base URL must be an official API host without /v3.", 503);
  return { base, environment: base.includes("sandbox") ? "sandbox" : "production", market: process.env.LALAMOVE_MARKET ?? "PH" };
}
export function requireLalamoveBooking() {
  if (process.env.LALAMOVE_ENABLED !== "true") throw new WorkflowError("New Lalamove bookings are disabled.", 503);
  const config = lalamoveConfig();
  if (config.market !== "PH") throw new WorkflowError("This integration is configured for the PH market.", 503);
  const prefix = config.environment === "sandbox" ? "test" : "prod";
  if (!process.env.LALAMOVE_API_KEY?.startsWith(`pk_${prefix}`) || !process.env.LALAMOVE_API_SECRET?.startsWith(`sk_${prefix}`))
    throw new WorkflowError("Lalamove credentials are missing or do not match the environment.", 503);
}
export function signLalamove(secret: string, timestamp: string, method: string, path: string, body: string) {
  return createHmac("sha256", secret).update(`${timestamp}\r\n${method.toUpperCase()}\r\n${path}\r\n\r\n${body}`).digest("hex");
}
export class LalamoveError extends WorkflowError {
  constructor(public providerStatus: number, public requestId: string, public uncertain = false) {
    super(providerStatus === 402 ? "Lalamove wallet has insufficient credit." : providerStatus === 429
      ? "Lalamove request limit reached. Try again later." : `Lalamove request failed. Reference: ${requestId}`,
    providerStatus === 429 ? 429 : 502);
  }
}
/** No mutation retries: a lost response may still have created a paid booking. */
export async function lalamoveRequest<T>(method: string, path: string, payload?: unknown): Promise<T> {
  const config = lalamoveConfig();
  const key = process.env.LALAMOVE_API_KEY;
  const secret = process.env.LALAMOVE_API_SECRET;
  if (!key || !secret) throw new WorkflowError("Lalamove credentials are not configured.", 503);
  const prefix = config.environment === "sandbox" ? "test" : "prod";
  if (!key.startsWith(`pk_${prefix}`) || !secret.startsWith(`sk_${prefix}`))
    throw new WorkflowError("Lalamove credentials do not match the configured environment.", 503);
  const timestamp = Date.now().toString();
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const signedPath = `/v3${path}`;
  const requestId = randomUUID();
  try {
    const response = await fetch(`${config.base}${signedPath}`, {
      method, signal: AbortSignal.timeout(15000), redirect: "error",
      headers: { Authorization: `hmac ${key}:${timestamp}:${signLalamove(secret, timestamp, method, signedPath, body)}`,
        Market: config.market, "Request-ID": requestId, "Content-Type": "application/json", Accept: "application/json" },
      ...(payload === undefined ? {} : { body }),
    });
    if (!response.ok) throw new LalamoveError(response.status, requestId, response.status >= 500 || response.status === 408);
    const result = await response.text();
    return result ? JSON.parse(result) as T : {} as T;
  } catch (error) {
    if (error instanceof LalamoveError) throw error;
    throw new LalamoveError(502, requestId, true);
  }
}
