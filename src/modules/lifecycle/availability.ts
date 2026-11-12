import { and, eq, sql } from "drizzle-orm";
import { inventory, products, vehicles, warehouses, users } from "../../db/schema";

// Correlated predicates work in selectors, counts and mutations without joins.
export const activeWarehouse = () => and(eq(warehouses.is_active, true), eq(warehouses.is_archived, false));
export const activeUser = () => and(eq(users.is_active, true), eq(users.is_archived, false));
export const activeVehicle = () => and(eq(vehicles.is_active, true), eq(vehicles.is_archived, false),
  sql`exists (select 1 from warehouses lifecycle_w where lifecycle_w.id = ${vehicles.warehouse_id} and lifecycle_w.is_active and not lifecycle_w.is_archived)`);
export const activeInventory = () => and(eq(inventory.is_active, true), eq(inventory.is_archived, false),
  sql`exists (select 1 from products lifecycle_p where lifecycle_p.id = ${inventory.product_id} and lifecycle_p.is_active and not lifecycle_p.is_archived)`,
  sql`exists (select 1 from warehouses lifecycle_w where lifecycle_w.id = ${inventory.warehouse_id} and lifecycle_w.is_active and not lifecycle_w.is_archived)`);
export const activeProduct = () => and(eq(products.is_active, true), eq(products.is_archived, false));

// Staff and driver access also depends on their assigned warehouse.
export const operationalUser = () => and(activeUser(), sql`(
  ${users.role} not in ('staff', 'driver')
  or (${users.role} = 'staff' and exists (select 1 from staffs lifecycle_s join warehouses lifecycle_w on lifecycle_w.id = lifecycle_s.warehouse_id where lifecycle_s.user_id = ${users.id} and lifecycle_w.is_active and not lifecycle_w.is_archived))
  or (${users.role} = 'driver' and exists (select 1 from drivers lifecycle_d join warehouses lifecycle_w on lifecycle_w.id = lifecycle_d.warehouse_id where lifecycle_d.user_id = ${users.id} and lifecycle_w.is_active and not lifecycle_w.is_archived))
)`);
