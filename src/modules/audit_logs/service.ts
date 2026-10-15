import { count, desc, eq, ilike, or } from "drizzle-orm";
import { db } from "../../db";
import { audit_logs, users } from "../../db/schema";

export abstract class AuditLogService {
  static async getAuditLogsByOffset(page = 0, limit = 10, search = "") {
    const searchQuery = search
      ? or(
          ilike(audit_logs.action, `%${search}%`),
          ilike(audit_logs.entity_type, `%${search}%`),
          ilike(audit_logs.entity_id, `%${search}%`),
          ilike(audit_logs.description, `%${search}%`),
          ilike(audit_logs.ip_address, `%${search}%`),
          ilike(users.name, `%${search}%`),
          ilike(users.email, `%${search}%`),
        )
      : undefined;

    const [totalResult, rows] = await Promise.all([
      db
        .select({ count: count() })
        .from(audit_logs)
        .leftJoin(users, eq(audit_logs.user_id, users.id))
        .where(searchQuery),
      db
        .select({
          id: audit_logs.id,
          user_id: audit_logs.user_id,
          action: audit_logs.action,
          entity_id: audit_logs.entity_id,
          entity_type: audit_logs.entity_type,
          description: audit_logs.description,
          old_value: audit_logs.old_value,
          new_value: audit_logs.new_value,
          metadata: audit_logs.metadata,
          ip_address: audit_logs.ip_address,
          user_agent: audit_logs.user_agent,
          created_at: audit_logs.created_at,
        })
        .from(audit_logs)
        .leftJoin(users, eq(audit_logs.user_id, users.id))
        .where(searchQuery)
        .orderBy(desc(audit_logs.id))
        .offset(Math.max(page * limit, 0))
        .limit(limit),
    ]);

    return { rows, total: totalResult[0]?.count ?? 0 };
  }
}
