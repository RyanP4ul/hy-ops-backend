import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { deliveries, orders, staffs, vehicles } from "../../db/schema";
import { WorkflowError } from "../../utils/workflow-error";

export type AssignmentActor = { sub: unknown; role: unknown };
export async function staffWarehouse(
  user: AssignmentActor,
): Promise<number | undefined> {
  if (user.role === "admin") return undefined;
  
  if (user.role !== "staff")
    throw new WorkflowError("Staff access required.", 403);

  const [staff] = await db
    .select({ warehouseId: staffs.warehouse_id })
    .from(staffs)
    .where(eq(staffs.user_id, Number(user.sub)));
  if (!staff)
    throw new WorkflowError("Your staff warehouse is not configured.", 403);
  return staff.warehouseId;
}

export async function assertDeliveryScope(
  tx: Pick<typeof db, "select">,
  id: number,
  warehouseId?: number,
) {
  if (warehouseId === undefined) return;
  const [row] = await tx
    .select({ id: deliveries.id })
    .from(deliveries)
    .innerJoin(vehicles, eq(vehicles.id, deliveries.vehicle_id))
    .where(and(eq(deliveries.id, id), eq(vehicles.warehouse_id, warehouseId)));
  if (!row)
    throw new WorkflowError("Delivery not found in your warehouse.", 404);
}

export async function assertOrderScope(id: number, warehouseId?: number) {
  if (warehouseId === undefined) return;
  const [order] = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.id, id), eq(orders.warehouse_id, warehouseId)));
  if (!order)
    throw new WorkflowError("Order not found in your warehouse.", 404);
}
