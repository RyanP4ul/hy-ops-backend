import { staffWarehouse } from "../deliveries/scope";
import { Elysia, t } from "elysia";
import { UserService } from "./service";
import { userModel } from "./model";
import { logger } from "../../utils/logger";
import { UserMutationError } from "./mutation-policy";
import { AuthUser } from "../auth/schema";

export const userRoutes = new Elysia({ prefix: "/users" })
  .decorate("user", {} as AuthUser)
  .use(userModel)
  .onError(({ error, set }) => {
    if (error instanceof UserMutationError) {
      set.status = error.status;
      return { message: error.message };
    }
  })
  .onBeforeHandle(async ({ request, user, set }) => {
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;

    // The parent auth guard verifies the token. Recheck the current account
    // here so stale role claims and revoked sessions cannot manage users.
    const actorId = Number(user.sub);
    if (!Number.isSafeInteger(actorId) || actorId < 1) {
      set.status = 401;
      return { message: "Unauthorized" };
    }

    const actor = await UserService.getMutationActor(actorId);
    if (!actor || actor.token_version !== user.token_version) {
      set.status = 401;
      return { message: "Unauthorized" };
    }

    if (actor.role !== "admin") {
      set.status = 403;
      return { message: "Only administrators can manage user accounts." };
    }
  })
  .get("/", async ({ query, set }) => {
    const page = Math.max(Number.parseInt(query.page ?? "0", 10) || 0, 0);
    const limit = Math.min(
      Math.max(Number.parseInt(query.limit ?? "10", 10) || 10, 1),
      50,
    );
    const search = query.search?.trim() ?? "";
    const result = await UserService.getUsers(page, limit, search);

    set.headers["X-Total-Count"] = result.total;
    return result.rows;
  })
  .get("/customers", async ({ query }) => {
    const page = Math.max(Number.parseInt(query.page ?? "0", 10) || 0, 0);
    const limit = Math.min(
      Math.max(Number.parseInt(query.limit ?? "10", 10) || 10, 1),
      50,
    );

    const contact = query.contact === "phone" || query.contact === "email" ? query.contact : undefined;
    return await UserService.getCustomers(page, limit, query.search?.trim() ?? "", contact);
  })
  .get(
    "/:id",
    async ({ params }) => await UserService.getUserById(Number(params.id)),
  )
  .post(
    "/",
    async ({ body, set, user }) => {
      const result = await UserService.createUser(body, { id: Number(user.sub), tokenVersion: Number(user.token_version) });

      if ("errors" in result) {
        set.status = 400;
        return { errors: result.errors };
      }

      return result;
    },
    {
      body: "user.create",
    },
  )
  .put(
    "/:id",
    async ({ params, body, query, set, user }) => {
      if (Number(params.id) === Number(user.sub) && body.role !== "admin") {
        set.status = 403;
        return { message: "You cannot remove your own administrator access." };
      }

      const result = await UserService.updateUser(
        Number(params.id),
        Number(query.version),
        body,
        { id: Number(user.sub), tokenVersion: Number(user.token_version) },
      );

      if ("errors" in result) {
        set.status = 400;
        return { errors: result.errors };
      }

      return result;
    },
    {
      params: t.Object({ id: t.Numeric({ minimum: 1 }) }),
      body: "user.update",
    },
  )
  .patch(
    "/:id/password",
    async ({ params, body, set, user }) => {
      const result = await UserService.changePassword(
        Number(params.id),
        body.password,
        { id: Number(user.sub), tokenVersion: Number(user.token_version) },
      );

      if ("errors" in result) {
        set.status = 400;
        return { errors: result.errors };
      }

      return result;
    },
    {
      params: t.Object({ id: t.Numeric({ minimum: 1 }) }),
      body: "user.changePassword",
    },
  )
  .delete(
    "/:id",
    async ({ params, query, user, set }) => {
      if (Number(params.id) === Number(user.sub)) {
        set.status = 403;
        return { message: "You cannot delete your own account." };
      }

      return await UserService.deleteUser(
        Number(params.id),
        Number(query.version),
      );
    },
    { params: t.Object({ id: t.Numeric({ minimum: 1 }) }) },
  )
  .post(
    "/:id/archive",
    async ({ query, params, user, set }) => {
      if (Number(params.id) === Number(user.sub)) {
        set.status = 403;
        return { message: "You cannot deactivate your own account." };
      }

      return await UserService.archiveUser(
        Number(user.sub),
        Number(params.id),
        Number(query.version || 0),
        { id: Number(user.sub), tokenVersion: Number(user.token_version) },
      );
    },
    { params: t.Object({ id: t.Numeric({ minimum: 1 }) }) },
  )
  .get("/drivers", async ({ query, user }) => {
    const page = Math.max(Number.parseInt(query.page ?? "0", 10) || 0, 0);
    const limit = Math.min(
      Math.max(Number.parseInt(query.limit ?? "10", 10) || 10, 1),
      50,
    );
    const search = query.search?.trim() ?? "";
    const warehouse_id = await staffWarehouse(user) ?? (query.warehouse_id ? Number(query.warehouse_id) : -1);
    return await UserService.getAllDrivers(page, limit, search, warehouse_id);
  });
// .post("/", async ({ body }) => UserService.createUser(body, { id: Number(user.sub), tokenVersion: Number(user.token_version) }), {
//   body: t.Object({
//     name: t.String({ minLength: 1, maxLength: 100 }),
//     email: t.String({ minLength: 3, maxLength: 255 }),
//     password: t.String({ minLength: 8, maxLength: 255 }),
//     role: t.Union([
//       t.Literal("admin"),
//       t.Literal("staff"),
//       t.Literal("driver"),
//     ]),
//   }),
// })
// .put(
//   "/:id",
//   async ({ params, body, set }) => {
//     const user = await UserService.updateUser(Number(params.id), body);
//     if (!user) {
//       set.status = 404;
//       return { message: "User not found" };
//     }
//     return user;
//   },
//   {
//     params: t.Object({ id: t.Numeric({ minimum: 1 }) }),
//     body: t.Object({
//       name: t.String({ minLength: 1, maxLength: 100 }),
//       email: t.String({ minLength: 3, maxLength: 255 }),
//       password: t.Optional(t.String({ minLength: 8, maxLength: 255 })),
//       role: t.Union([
//         t.Literal("admin"),
//         t.Literal("staff"),
//         t.Literal("driver"),
//       ]),
//     }),
//   },
// )
// .delete(
//   "/:id",
//   async ({ params }) => {
//     await UserService.deleteUser(Number(params.id));
//     return { message: "User deleted" };
//   },
//   { params: t.Object({ id: t.Numeric({ minimum: 1 }) }) },
// );
