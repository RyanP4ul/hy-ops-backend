import { createHmac, randomUUID } from "node:crypto";

const BASE_URL =
  process.env.LALAMOVE_BASE_URL ?? "https://rest.sandbox.lalamove.com";

const API_KEY = process.env.LALAMOVE_API_KEY;
const API_SECRET = process.env.LALAMOVE_API_SECRET || "";
const MARKET = process.env.LALAMOVE_MARKET ?? "PH";

if (!API_KEY || !API_SECRET) {
  throw new Error("Missing Lalamove API credentials");
}

export async function lalamoveRequest<T>(
  method: string,
  path: string,
  payload?: unknown,
): Promise<T> {
  const timestamp = Date.now().toString();
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const version = Bun.env.LALAMOVE_VERSION || "v3";
  const signedPath = `/${version}${path}`;

  // The signed path must include the API version.
  const rawSignature =
    `${timestamp}\r\n` +
    `${method.toUpperCase()}\r\n` +
    `${signedPath}\r\n\r\n` +
    body;

  const signature = createHmac("sha256", API_SECRET)
    .update(rawSignature)
    .digest("hex");

  const authorization = `hmac ${API_KEY}:${timestamp}:${signature}`;

  const response = await fetch(`${BASE_URL}${signedPath}`, {
    method,
    headers: {
      Authorization: authorization,
      Market: MARKET,
      "Request-ID": randomUUID(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    ...(payload === undefined ? {} : { body }),
  });

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`Lalamove API error (${response.status}): ${responseText}`);
  }

  return responseText ? (JSON.parse(responseText) as T) : ({} as T);
}
