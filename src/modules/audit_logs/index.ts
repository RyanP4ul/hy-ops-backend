import { Elysia } from "elysia";
import { AuditLogService } from "./service";

export const auditLogRoutes = new Elysia({ prefix: "/audit-logs" }).get(
  "/",
  async ({ query, set }) => {
    const page = Math.max(Number.parseInt(query.page ?? "0", 10) || 0, 0);
    const limit = Math.min(
      Math.max(Number.parseInt(query.limit ?? "10", 10) || 10, 1),
      50,
    );
    const search = query.search?.trim() ?? "";
    const result = await AuditLogService.getAuditLogsByOffset(
      page,
      limit,
      search,
    );

    set.headers["X-Total-Count"] = result.total;
    return result.rows;
  },
);
