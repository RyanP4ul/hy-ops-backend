import Elysia, { t } from "elysia";
import { CalendarService } from "./services";
import { calendarModel } from "./model";

export const calendarRoutes = new Elysia({
  prefix: "/calendar",
})
  .use(calendarModel)
  .put("/event/:id", ({ params, body }) => CalendarService.updateEvent(params.id, body), { params: t.Object({ id: t.Numeric({ minimum: 1 }) }), body: "calendar.event.update" })
  .delete("/event/:id", ({ params, query }) => CalendarService.deleteEvent(params.id, query.version), { params: t.Object({ id: t.Numeric({ minimum: 1 }) }), query: t.Object({ version: t.Numeric({ minimum: 1 }) }) })
  .get("/events", async ({ set }) => {
    return await CalendarService.getEvents();
  })
  .post(
    "/event",
    async ({ body, set }) => {
      return await CalendarService.createEvent(body);
    },
    {
      body: "calendar.event.create",
    },
  );
