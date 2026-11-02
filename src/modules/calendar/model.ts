import { Elysia, t, type Static } from "elysia";
const day = t.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const time = t.String({ pattern: "^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$" });
export const calendarEventCreate = t.Object({
  title: t.String({ minLength: 1, maxLength: 50 }),
  category: t.Union(["DELIVERY", "ORDER_FULFILLMENT", "INVENTORY_WAREHOUSE", "VEHICLE_MAINTENANCE", "STAFF_SCHEDULE", "MEETING_APPOINTMENT", "OTHER"].map((value) => t.Literal(value))),
  date: day, start_time: time, end_time: time,
});
export type CalendarEventCreateType = Static<typeof calendarEventCreate>;
export const calendarModel = new Elysia().model({ "calendar.event.create": calendarEventCreate,
  "calendar.event.update": t.Object({ ...calendarEventCreate.properties, version: t.Integer({ minimum: 1 }) }),
});
