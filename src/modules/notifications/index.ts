import { Elysia } from "elysia";
import { NotificationService } from "./service";
import { AuthUser } from "../auth/schema";

export const notificationRoutes = new Elysia({ prefix: "/notifications" })
  .decorate("user", AuthUser)
  .get("/", async ({ user }) => {
    return NotificationService.getNotificationsByUserId(user.sub);
  })
  .post("/mark-all-read", async ({ user }) => {
    return await NotificationService.markAllAsRead(user.sub);
  });
