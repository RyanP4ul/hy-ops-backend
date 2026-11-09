import { Elysia, t } from "elysia";
import { NotificationService } from "./service";
import { AuthUser } from "../auth/schema";

export const notificationRoutes = new Elysia({ prefix: "/notifications" })
  .decorate("user", AuthUser)
  .get("/", async ({ user }) => {
    return NotificationService.getNotificationsByUserId(user.sub);
  }, { detail: { summary: 'List root', description: 'GET endpoint for root in the notifications module.', tags: ['Notifications'] } })
  .post("/:id/read", ({ params, user }) => NotificationService.markAsRead(user.sub, params.id), {
      detail: { summary: 'Create by id read', description: 'POST endpoint for by id read in the notifications module.', tags: ['Notifications'] },
    params: t.Object({ id: t.Numeric({ minimum: 1 }) }),
  })
  .post("/mark-all-read", async ({ user }) => {
    return await NotificationService.markAllAsRead(user.sub);
  }, { detail: { summary: 'Create mark all read', description: 'POST endpoint for mark all read in the notifications module.', tags: ['Notifications'] } });
