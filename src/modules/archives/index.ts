import { Elysia } from "elysia";
import { AuthUser } from "../auth/schema";
import { ArchiveService } from "./service";

export const archivesRoutes = new Elysia({ prefix: "/archives" })
  .decorate("user", AuthUser)
  .get("/", async ({ set, query }) => {
    const page = query.page ? parseInt(query.page) : 0;
    let limit = query.limit ? parseInt(query.limit) : 10;

    const result = await ArchiveService.getArchives(page, limit);

    set.headers["X-Total-Count"] = result.total;
    return result.rows;
  })
  .put("/:id/restore", async ({ params }) => {
    const archiveId = parseInt(params.id);
    return await ArchiveService.restoreArchive(archiveId);
  });
