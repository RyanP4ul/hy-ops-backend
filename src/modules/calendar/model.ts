import { Elysia, t, Static } from "elysia";

export const calendarEventCreate = t.Object({
  title: t.String({ maxLength: 255 }),
  category: t.String({ maxLength: 255 }),
  date: t.String(),
  start_time: t.String(),
  end_time: t.String(),
});

export type CalendarEventCreateType = Static<typeof calendarEventCreate>;

export const calendarModel = new Elysia().model({
  "calendar.event.create": calendarEventCreate,
});
