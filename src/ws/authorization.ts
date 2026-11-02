const staffTopics = new Set(["dashboard", "products", "inventory", "warehouses", "orders", "deliveries", "fleet-map", "vehicles", "communications", "analysis-reports", "delivery-expenses", "delivery-schedules"]);
const adminTopics = new Set([...staffTopics, "users", "customers", "drivers", "payments", "delivery-schedules", "calendar", "sessions-and-logs", "audit-logs", "archives", "settings", "automations"]);
const operationalRequests = new Set([
  "PRODUCT_ADDED", "PRODUCT_UPDATED", "PRODUCT_DELETED",
  "INVENTORY_ADDED", "INVENTORY_UPDATED", "INVENTORY_DELETED",
  "ORDER_ADDED", "ORDER_UPDATED", "ORDER_DELETED",
  "DELIVERY_CREATED", "DELIVERY_UPDATED",
  "VEHICLE_ADDED", "VEHICLE_UPDATED", "VEHICLE_DELETED",
  "WAREHOUSE_ADDED", "WAREHOUSE_UPDATED", "WAREHOUSE_DELETED", "WAREHOUSE_ARCHIVED", "WAREHOUSE_RESTORED",
]);
const administrativeRequests = new Set([
  ...operationalRequests, "USER_ADDED", "USER_UPDATED", "USER_DELETED", "USER_ARCHIVED", "USER_RESTORED",
  "PAYMENT_UPDATED", "DELIVERY_SCHEDULE_CREATED", "ARCHIVE_CREATED", "ARCHIVE_RESTORED",
]);

export function canSubscribe(role: string, topic: string): boolean {
  return role === "admin" ? adminTopics.has(topic) : role === "staff" && staffTopics.has(topic);
}

export function canSendRequest(role: string, name: string): boolean {
  if (name === "CHANGE_PAGE") return role === "admin" || role === "staff";
  if (name === "DRIVER_LOCATION_UPDATE") return role === "driver";
  if (role === "admin") return administrativeRequests.has(name);
  return role === "staff" && operationalRequests.has(name);
}
