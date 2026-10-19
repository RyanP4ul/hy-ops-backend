import { Elysia } from "elysia";
import { socketManager } from "../../ws/socket-manager";
import { AuthUser } from "../auth/schema";
import { sessionService } from "./service";
import { requireRole } from "../../middleware/auth.middleware";
import { Role } from "../../constant/role";

export const sessionRoutes = new Elysia({ prefix: "/sessions" })
  .decorate("user", AuthUser)
  //.onBeforeHandle(({ user, set }) => requireRole([Role.ADMIN], { user, set }))
  .get("/me", async ({ user }) => {
    return user;
  })
  .get("/", async ({ query, set }) => {
    const page = query.page ? parseInt(query.page) : 0;
    let limit = query.limit ? parseInt(query.limit) : 10;
    const search = query.search ? query.search.trim() : "";

    const filteredSockets = Array.from(
      socketManager.getSockets().entries(),
    ).filter(([id, session]) => {
      if (!search) {
        return true;
      }

      const email = session.user?.email ?? "";
      const name = session.user?.name ?? "";

      return (
        email.toLowerCase().includes(search.toLowerCase()) ||
        name.toLowerCase().includes(search.toLowerCase())
      );
    });

    const total = filteredSockets.length;
    const offset = page * limit;

    const sessions = filteredSockets
      .slice(offset, offset + limit)
      .map(([_, session]) => ({
        id: session.ws.id,
        ip_address: session.ip_address,
        user: session.user,
        page: session.page,
      }));

    set.headers["X-Total-Count"] = total;

    return sessions;
  })
  .delete("/:id", async ({ params, set }) => {
    const session = socketManager.getSocket(params.id);

    if (!session) {
      set.status = 404;
      return { message: "Session not found" };
    }

    session.ws.close(4001, "Disconnected by administrator");

    return { success: true };
  })
  .get("/logs", async ({ query, set }) => {
    const page = query.page ? parseInt(query.page) : 1;
    const limit = query.limit ? parseInt(query.limit) : 10;
    const search = query.search ? query.search.trim() : "";

    const result = await sessionService.getWsLogs(page, limit, search);

    set.headers["X-Total-Count"] = result.total;

    return result.rows;
  });
