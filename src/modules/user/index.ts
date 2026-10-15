import { Elysia, t } from "elysia";
import { UserService } from "./service";
import { userModel } from "./model";
import { logger } from "../../utils/logger";
import { AuthUser } from "../auth/schema";

export const userRoutes = new Elysia({ prefix: "/users" })
  .decorate("user", AuthUser)
  .use(userModel)
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

    return await UserService.getCustomers(page, limit);
  })
  .get(
    "/:id",
    async ({ params }) => await UserService.getUserById(Number(params.id)),
  )
  .post(
    "/",
    async ({ body, set }) => {
      const result = await UserService.createUser(body);

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
    async ({ params, body, query, set }) => {
      const result = await UserService.updateUser(
        Number(params.id),
        Number(query.version),
        body,
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
  .delete(
    "/:id",
    async ({ params, query }) => {
      return await UserService.deleteUser(
        Number(params.id),
        Number(query.version),
      );
    },
    { params: t.Object({ id: t.Numeric({ minimum: 1 }) }) },
  )
  .post(
    "/:id/archive",
    async ({ query, params, user }) => {
      return await UserService.archiveUser(
        Number(user.sub),
        Number(params.id),
        Number(query.version || 0),
      );
    },
    { params: t.Object({ id: t.Numeric({ minimum: 1 }) }) },
  );
// .post("/", async ({ body }) => UserService.createUser(body), {
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
