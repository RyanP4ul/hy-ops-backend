import { Elysia } from "elysia";
import { AuthUser } from "../auth/schema";
import { UserService } from "../user/service";
import { UserMutationError } from "../user/mutation-policy";
import { ArchiveService } from "./service";

export const archivesRoutes = new Elysia({ 
  prefix: "/archives",
  detail: {
    tags: ["Archives"]
  }
})
  .decorate("user", AuthUser)
  .onError(({ error, set }) => {
    if (error instanceof UserMutationError) { set.status = error.status; return { message: error.message }; }
  })
  .onBeforeHandle(async ({ user, set }) => {
    const id = Number(user.sub);
    const actor = Number.isSafeInteger(id) && id > 0 ? await UserService.getMutationActor(id) : undefined;
    if (!actor || actor.token_version !== user.token_version) { set.status = 401; return { message: "Unauthorized" }; }
    if (actor.role !== "admin") { set.status = 403; return { message: "Only administrators can access archives." }; }
  })
  .get("/", async ({ set, query }) => {
    const page = query.page ? parseInt(query.page) : 0;
    let limit = query.limit ? parseInt(query.limit) : 10;

    const result = await ArchiveService.getArchives(page, limit);

    set.headers["X-Total-Count"] = result.total;
    return result.rows;
  }, {
    detail: {
      summary: "Get archived users",
      description: "Retrieve archived user accounts with pagination.",
      tags: ["Archives"],
    },
  })
  .put("/:id/restore", async ({ params, user }) => {
    const archiveId = parseInt(params.id);
    return await ArchiveService.restoreArchive(archiveId, { id: Number(user.sub), tokenVersion: Number(user.token_version) });
  }, {
    detail: {
      summary: "Restore an archived user",
      description: "Restore an archived user account by its identifier.",
      tags: ["Archives"],
    },
  });
