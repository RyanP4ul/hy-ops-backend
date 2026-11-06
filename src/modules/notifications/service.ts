import { db } from "@/db/index";
import { notifications } from "@/db/schema/notification";
import { WorkflowError } from "../../utils/workflow-error";
import { desc, eq, and, count } from "drizzle-orm";

export abstract class NotificationService {
  static async getNotificationsByUserId(user_id: number) {
    const [total_unread] = await db
      .select({ count: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.user_id, user_id),
          eq(notifications.is_read, false),
        ),
      );

    const notificationsList = await db
      .select({
        id: notifications.id,
        title: notifications.title,
        message: notifications.message,
        type: notifications.type,
        is_read: notifications.is_read,
        created_at: notifications.created_at,
      })
      .from(notifications)
      .where(eq(notifications.user_id, user_id))
      .orderBy(desc(notifications.created_at), desc(notifications.id));

    return {
      total_unread: total_unread.count,
      rows: notificationsList,
    };
  }

  static async markAsRead(userId: number, notificationId: number) {
    const rows = await db.update(notifications).set({ is_read: true })
      .where(and(eq(notifications.id, notificationId), eq(notifications.user_id, userId)))
      .returning({ id: notifications.id });
    if (!rows.length) throw new WorkflowError("Notification not found.", 404);
    return { message: "Notification marked as read." };
  }

  static async markAllAsRead(user_id: number) {
    return await db.transaction(async (tx) => {
      await tx
        .update(notifications)
        .set({ is_read: true })
        .where(
          and(
            eq(notifications.user_id, user_id),
            eq(notifications.is_read, false),
          ),
        );

      return { message: "All notifications marked as read." };
    });
  }

  static async createNotification(
    user_id: number,
    title: string,
    message: string,
    type: string,
  ) {
    await db.transaction(async (tx) => {
      const notification = await tx.insert(notifications).values({
        user_id,
        title,
        message,
        type,
        created_at: Math.floor(Date.now() / 1000),
      });

      if (!notification) {
        throw new Error("Failed to create notification.");
      }

      // NO NEED TO ADD TOAST FOR THIS
      return true;
    });

    return null;
  }
}
