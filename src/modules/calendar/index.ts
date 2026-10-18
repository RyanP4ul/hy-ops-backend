import Elysia from "elysia";
import { CalendarService } from "./services";
import { calendarModel } from "./model";

export const calendarRoutes = new Elysia({
  prefix: "/calendar",
})
  .use(calendarModel)
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
