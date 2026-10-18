import { db } from "..";
import { logger } from "../../utils/logger";
import { calendar_events, CalendarEventInsert } from "../schema/calendar";

const calendarData: CalendarEventInsert[] = [
  {
    title: "Morning delivery route - North district",
    category: "DELIVERY",
    date: new Date().toISOString().slice(0, 10),
    start_time: "08:00:00",
    end_time: "12:00:00",
  },
  {
    title: "Afternoon delivery route - South district",
    category: "DELIVERY",
    date: new Date().toISOString().slice(0, 10),
    start_time: "13:00:00",
    end_time: "17:00:00",
  },
  {
    title: "Warehouse inventory stocktake",
    category: "INVENTORY_WAREHOUSE",
    date: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
    start_time: "09:00:00",
    end_time: "11:00:00",
  },
  {
    title: "Vehicle maintenance - Truck #1",
    category: "VEHICLE_MAINTENANCE",
    date: new Date(Date.now() + 172800000).toISOString().slice(0, 10),
    start_time: "08:00:00",
    end_time: "10:00:00",
  },
  {
    title: "Team scheduling meeting",
    category: "MEETING_APPOINTMENT",
    date: new Date(Date.now() + 259200000).toISOString().slice(0, 10),
    start_time: "10:00:00",
    end_time: "11:00:00",
  },
];

export async function calendarSeeds() {
  try {
    await db.transaction(async (tx) => {
      await tx.insert(calendar_events).values(calendarData).returning();
    });

    logger.info("Calendar seed completed successfully.");
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Error seeding calendar:", error.message);
    }

    throw error;
  }
}
