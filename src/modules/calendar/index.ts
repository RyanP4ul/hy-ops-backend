import Elysia, { t } from "elysia";
import { CalendarService } from "./services";
import { calendarModel } from "./model";

export const calendarRoutes = new Elysia({
  prefix: "/calendar",
  detail: { tags: ["Calendar"] },
})
  .use(calendarModel)
  .put("/event/:id", ({ params, body }) => CalendarService.updateEvent(params.id, body), {
    params: t.Object({ id: t.Numeric({ minimum: 1 }) }),
    body: "calendar.event.update",
    detail: {
      summary: "Update a calendar event",
      description: "Update an existing calendar event by its identifier.",
      tags: ["Calendar"],
    },
  })
  .delete("/event/:id", ({ params, query }) => CalendarService.deleteEvent(params.id, query.version), {
    params: t.Object({ id: t.Numeric({ minimum: 1 }) }),
    query: t.Object({ version: t.Numeric({ minimum: 1 }) }),
    detail: {
      summary: "Delete a calendar event",
      description: "Delete a calendar event by its identifier.",
      tags: ["Calendar"],
    },
  })
  .get("/events", async ({ set }) => {
    return await CalendarService.getEvents();
  }, {
    detail: {
      summary: "Get calendar events",
      description: "Retrieve calendar events.",
      tags: ["Calendar"],
    },
  })
  .post(
    "/event",
    async ({ body, set }) => {
      return await CalendarService.createEvent(body);
    },
    {
      body: "calendar.event.create",
      detail: {
        summary: "Create a calendar event",
        description: "Create a new calendar event.",
        tags: ["Calendar"],
      },
    },
  );
