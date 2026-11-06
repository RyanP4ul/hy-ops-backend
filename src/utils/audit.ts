export function redactAuditPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAuditPayload);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, /password|token|secret|authorization|cookie|email|phone|address|recipient|latitude|longitude|message|notes|reason/i.test(key) ? "[REDACTED]" : redactAuditPayload(item),
    ]));
  }
  // Legacy callers may wrap whole payloads in JSON strings.
  if (typeof value === "string" && /^[\[{]/.test(value.trim())) {
    try { return redactAuditPayload(JSON.parse(value)); } catch { return "[OMITTED]"; }
  }
  return value;
}

export function auditTarget(path: string) {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "api") parts.shift();
  if (parts[0] === "orders" && parts[1] === "customers" && /^\d+$/.test(parts[2] ?? "") && parts[3] === "addresses") {
    return { entityType: "customers", entityId: parts[2] };
  }
  return { entityType: parts[0] ?? "unknown", entityId: parts[1] && /^\d+$/.test(parts[1]) ? parts[1] : "unknown" };
}
