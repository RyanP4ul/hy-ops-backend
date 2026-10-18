import { db } from "@/db/index";
import {
  calendar_events,
  CalendarEventInsert,
  CalendarEventType,
} from "@/db/schema/calendar";
import { CalendarEventCreateType } from "./model";

export abstract class CalendarService {
  static async getEvents() {
    const result = await db
      .select({
        id: calendar_events.id,
        title: calendar_events.title,
        category: calendar_events.category,
        date: calendar_events.date,
        start_time: calendar_events.start_time,
        end_time: calendar_events.end_time,
      })
      .from(calendar_events);

    return result;
  }

  static async createEvent(data: CalendarEventCreateType) {
    return await db.transaction(async (tx) => {
      const [newEvent] = await tx
        .insert(calendar_events)
        .values({
          title: data.title,
          category: data.category as CalendarEventType,
          date: data.date,
          start_time: data.start_time,
          end_time: data.end_time,
          created_at: new Date(),
        })
        .returning({
          id: calendar_events.id,
        });

      if (!newEvent) {
        throw new Error("Failed to create event");
      }

      return {
        message: `Event created successfully with ID: ${newEvent.id}`,
      };
    });
  }
}
