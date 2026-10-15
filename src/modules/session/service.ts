import { db } from "@/db/index";
import { ws_logs, wsLogsInsert } from "@/db/schema/ws";
import { count, ilike, desc } from "drizzle-orm";

export abstract class SessionService {
  static async createWsLogs(data: wsLogsInsert) {
    return db.transaction(async (tx) => {
      const [log] = await tx
        .insert(ws_logs)
        .values({
          ...data,
          created_at: Math.floor(Date.now() / 1000),
        })
        .returning({ id: ws_logs.id });

      return log;
    });
  }

  // {
  //   "id": 38,
  //   "session_id": "4d40c31f0c7f2cda",
  //   "user_id": 1,
  //   "action": "CHANGE_PAGE",
  //   "payload": "[\"sessions-and-logs\"]",
  //   "created_at": 1790557797,
  //   "updated_at": 1790557797
  // },

  static async getWsLogs(
    page: number = 1,
    limit: number = 10,
    search: string = "",
  ) {
    const is_search_empty = !search;
    const offset = is_search_empty ? Math.max(page * limit, 0) : 0;

    const whereQuery = !is_search_empty
      ? ilike(ws_logs.session_id, `%${search}%`)
      : undefined;

    const total = await db
      .select({ count: count() })
      .from(ws_logs)
      .where(whereQuery);

    const logs = await db
      .select({
        ws_id: ws_logs.id,
        session_id: ws_logs.session_id,
        user_id: ws_logs.user_id,
        action: ws_logs.action,
        payload: ws_logs.payload,
      })
      .from(ws_logs)
      .where(whereQuery)
      .orderBy(desc(ws_logs.created_at))
      .offset(offset)
      .limit(limit);

    return {
      rows: logs,
      total: total[0].count,
    };
  }
}

export const sessionService = SessionService;
