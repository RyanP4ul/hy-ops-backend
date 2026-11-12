import { scheduleArchiveDeletion } from "./retention";
import { Elysia, t } from "elysia";
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
  .delete("/:id", ({ params, user, set }) => {
    set.status = 202;
    return scheduleArchiveDeletion(params.id, { id: Number(user.sub), tokenVersion: Number(user.token_version) });
  }, {
    params: t.Object({ id: t.Numeric({ minimum: 1 }) }),
    detail: { summary: "Schedule archived record deletion", description: "Keep the record archived for 30 days after confirmation, then automatically delete it if dependencies permit.", tags: ["Archives"] },
  })
  .get("/", async ({ set, query }) => {
    const page = query.page ? parseInt(query.page) : 0;
    let limit = query.limit ? parseInt(query.limit) : 10;

    const result = await ArchiveService.getArchives(page, limit);

    set.headers["X-Total-Count"] = result.total;
    return result.rows;
  }, {
    detail: {
      summary: "Get archived records",
      description: "Retrieve archived records with pagination.",
      tags: ["Archives"],
    },
  })
  .put("/:id/restore", async ({ params, user }) => {
    const archiveId = parseInt(params.id);
    return await ArchiveService.restoreArchive(archiveId, { id: Number(user.sub), tokenVersion: Number(user.token_version) });
  }, {
    detail: {
      summary: "Restore an archived record",
      description: "Restore an archived record account by its identifier.",
      tags: ["Archives"],
    },
  });
