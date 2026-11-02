import postgres from "postgres";

/** Shared invalidation channel: payloads contain no records or customer data.
 * Reconnect always refetches authoritative state; this is not a replay log.
 */
export async function startResourceEvents(publish: (event: string) => void) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for resource events.");
  const sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
  await sql.listen("hyops_resource_changed", (payload) => {
    try {
      const event = JSON.parse(payload);
      if (event.type === "RESOURCE_CHANGED" && typeof event.payload?.resource === "string" && typeof event.payload?.eventId === "string") publish(payload);
    } catch { /* Ignore unrelated or malformed notifications. */ }
  });
  return {
    changed: (resource: string) => sql.notify("hyops_resource_changed", JSON.stringify({ type: "RESOURCE_CHANGED", payload: { resource, eventId: crypto.randomUUID() } })),
    stop: () => sql.end({ timeout: 2 }),
  };
}
