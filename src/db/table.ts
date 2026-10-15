import { archives } from "./schema/archive";
import { audit_logs } from "./schema/audit_logs";
import { inventory } from "./schema/inventory";
import { products } from "./schema/products";
import { settings } from "./schema/settings";
import { users } from "./schema/users";
import { warehouses } from "./schema/warehouses";
import { vehicles } from "./schema/vehicles";
import { orders, order_items } from "./schema/order";
import { ws_logs } from "./schema/ws";

export const tables = {
  archives,
  inventory,
  audit_logs,
  order_items,
  orders,
  products,
  settings,
  users,
  warehouses,
  vehicles,
  ws_logs,
};

export type TableName = keyof typeof tables;

export function getTable(tableName: TableName) {
  return tables[tableName];
}
