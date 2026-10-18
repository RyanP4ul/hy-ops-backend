import { db } from "@/db/index";
import { orders } from "@/db/schema/order";
import { and, count, gte, lt, sql } from "drizzle-orm";

type AvailableDate = {
  date: string;
  available_slots: number;
};

export abstract class DeliveryScheduleService {
  static async getAvailableOrderDates({
    maxOrdersPerDay,
    daysAhead = 30,
  }: {
    maxOrdersPerDay: number;
    daysAhead?: number;
  }): Promise<AvailableDate[]> {
    if (!Number.isInteger(maxOrdersPerDay) || maxOrdersPerDay < 1) {
      throw new Error("maxOrdersPerDay must be a positive integer.");
    }

    if (!Number.isInteger(daysAhead) || daysAhead < 1) {
      throw new Error("daysAhead must be a positive integer.");
    }

    const today = sql<string>`(now() AT TIME ZONE 'Asia/Manila')::date`;
    const endDate = sql`((${today}) + ${daysAhead}::integer)::date`;

    const orderCounts = await db
      .select({
        date: sql<string>`(
        ${orders.created_at} AT TIME ZONE 'Asia/Manila')::date`,
        orderCount: count(),
      })
      .from(orders)
      .where(
        and(
          gte(
            sql`(${orders.created_at} AT TIME ZONE 'Asia/Manila')::date`,
            today,
          ),
          lt(
            sql`(${orders.created_at} AT TIME ZONE 'Asia/Manila')::date`,
            endDate,
          ),
        ),
      )
      .groupBy(sql`(${orders.created_at} AT TIME ZONE 'Asia/Manila')::date`);

    const countByDate = new Map(
      orderCounts.map((item) => [item.date, Number(item.orderCount)]),
    );

    const availableDates: AvailableDate[] = [];

    const start = new Date(
      new Date().toLocaleDateString("en-CA", {
        timeZone: "Asia/Manila",
      }) + "T00:00:00+08:00",
    );

    for (let i = 0; i < daysAhead; i++) {
      const current = new Date(start);
      current.setDate(current.getDate() + i);

      const date = [
        current.getFullYear(),
        String(current.getMonth() + 1).padStart(2, "0"),
        String(current.getDate()).padStart(2, "0"),
      ].join("-");

      const orderCount = countByDate.get(date) ?? 0;

      if (current.getDay() === 0) continue;

      if (orderCount >= maxOrdersPerDay) continue;

      availableDates.push({
        date,
        available_slots: maxOrdersPerDay - orderCount,
      });
    }

    return availableDates;
  }
}
