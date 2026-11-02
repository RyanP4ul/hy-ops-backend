import { WorkflowError } from "../../utils/workflow-error";
import { db } from "@/db/index";
import {
  calendar_events,
  CalendarEventInsert,
  CalendarEventType,
} from "@/db/schema/calendar";
import { CalendarEventCreateType } from "./model";
import { and, eq } from "drizzle-orm";

export abstract class CalendarService {
  static async getEvents() {
    const result = await db
      .select({
        id: calendar_events.id,
        version: calendar_events.version,
        title: calendar_events.title,
        category: calendar_events.category,
        date: calendar_events.date,
        start_time: calendar_events.start_time,
        end_time: calendar_events.end_time,
      })
      .from(calendar_events);

    return result;
  }

  static async getDeliveryEvents() {
    return await db
      .select({
        id: calendar_events.id,
        title: calendar_events.title,
        date: calendar_events.date,
        start_time: calendar_events.start_time,
        end_time: calendar_events.end_time,
      })
      .from(calendar_events)
      .where(eq(calendar_events.category, "DELIVERY"));
  }

  static validate(data: CalendarEventCreateType) {
    const seconds = (time: string) => { const parts = time.split(":").map(Number); return (parts[0] ?? NaN) * 3600 + (parts[1] ?? NaN) * 60 + (parts[2] ?? 0); };
    const parsed = new Date(`${data.date}T00:00:00Z`);
    if (!data.title.trim() || data.title.trim().length > 50 || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== data.date || seconds(data.end_time) <= seconds(data.start_time)) throw new WorkflowError("Use a valid date, a title up to 50 characters, and an end time after the start time.", 400);
  }
  static async updateEvent(id: number, data: CalendarEventCreateType & { version: number }) {
    this.validate(data);
    const [row] = await db.update(calendar_events).set({ ...data, title: data.title.trim(), category: data.category as CalendarEventType, version: data.version + 1 })
      .where(and(eq(calendar_events.id, id), eq(calendar_events.version, data.version))).returning({ id: calendar_events.id });
    if (!row) throw new WorkflowError("Event changed or was removed. Refresh the calendar.");
    return { id: row.id, message: "Event updated." };
  }
  static async deleteEvent(id: number, version: number) {
    const [row] = await db.delete(calendar_events).where(and(eq(calendar_events.id, id), eq(calendar_events.version, version))).returning({ id: calendar_events.id });
    if (!row) throw new WorkflowError("Event changed or was removed. Refresh the calendar.");
    return { message: "Event deleted." };
  }
  static async createEvent(data: CalendarEventCreateType) {
    this.validate(data);
    return await db.transaction(async (tx) => {
      const [newEvent] = await tx
        .insert(calendar_events)
        .values({
          title: data.title.trim(),
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
