import { db } from "@/db/index";
import { orders } from "@/db/schema/order";
import { deliveries, deliveries_stops } from "@/db/schema/deliveries";
import { and, count, eq, gte, lt, sql } from "drizzle-orm";
import { DAY, todayInManila } from "../../utils/time";

type AvailableDate = { date: string; available_slots: number };

export abstract class DeliveryScheduleService {
  static async getAvailableOrderDates({ maxOrdersPerDay, daysAhead = 30, warehouse_id = -1 }: {
    maxOrdersPerDay: number; daysAhead: number; warehouse_id?: number;
  }): Promise<AvailableDate[]> {
    if (!Number.isInteger(maxOrdersPerDay) || maxOrdersPerDay < 1) throw new Error("maxOrdersPerDay must be a positive integer.");
    if (!Number.isInteger(daysAhead) || daysAhead < 1) throw new Error("daysAhead must be a positive integer.");
    const today = todayInManila();
    const start = Date.parse(`${today}T00:00:00Z`);
    const end = new Date(start + daysAhead * DAY).toISOString().slice(0, 10);
    const counts = await db.select({ date: deliveries.scheduled_date, orderCount: count() })
      .from(deliveries_stops).innerJoin(deliveries, eq(deliveries_stops.delivery_id, deliveries.id))
      .innerJoin(orders, eq(deliveries_stops.order_id, orders.id))
      .where(and(sql`${deliveries.status} <> 'cancelled'`, gte(deliveries.scheduled_date, today), lt(deliveries.scheduled_date, end),
        warehouse_id > 0 ? eq(orders.warehouse_id, warehouse_id) : undefined))
      .groupBy(deliveries.scheduled_date);
    const countByDate = new Map(counts.map(row => [row.date, Number(row.orderCount)]));
    const dates: AvailableDate[] = [];
    for (let i = 0; i < daysAhead; i++) {
      const current = new Date(start + i * DAY);
      if (current.getUTCDay() === 0) continue;
      const date = current.toISOString().slice(0, 10);
      dates.push({ date, available_slots: Math.max(0, maxOrdersPerDay - (countByDate.get(date) ?? 0)) });
    }
    return dates;
  }
}
