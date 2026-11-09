import { WorkflowError } from "../../utils/workflow-error";

/** Public proxy path must match the URL Lalamove signs, not the internal route. */
export function lalamoveCallback() {
  const configuredUrl = process.env.LALAMOVE_WEBHOOK_URL?.trim();
  const configuredPath = process.env.LALAMOVE_WEBHOOK_PATH?.trim();
  if (!configuredUrl) return { url: null, path: configuredPath || "/webhooks/lalamove" };
  let url: URL;
  try { url = new URL(configuredUrl); }
  catch { throw new WorkflowError("LALAMOVE_WEBHOOK_URL must be a public HTTPS callback URL.", 503); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !url.pathname.endsWith("/webhooks/lalamove")) {
    throw new WorkflowError("Configure a public HTTPS URL ending in /webhooks/lalamove, without credentials or query parameters.", 503);
  }
  if (configuredPath && configuredPath !== url.pathname) {
    throw new WorkflowError("LALAMOVE_WEBHOOK_PATH must match the public callback URL path.", 503);
  }
  return { url: url.href, path: url.pathname };
}
