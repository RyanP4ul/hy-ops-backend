import { Elysia, t } from "elysia";
import { AuthUser } from "../auth/schema";
import { LifecycleService, lifecycleTables, type LifecycleResource } from "./service";

export const lifecycleRoutes = new Elysia().decorate("user", {} as AuthUser);
for (const resource of Object.keys(lifecycleTables) as LifecycleResource[]) {
  for (const action of ["activate", "deactivate", "archive"] as const) {
    // Existing archive routes delegate to the same service.
    if (action === "archive" && (resource === "warehouses" || resource === "users")) continue;
    lifecycleRoutes.post(`/${resource}/:id/${action}`, ({ params, body, user }) =>
      LifecycleService.change(resource, Number(params.id), body.version, action, { id: Number(user.sub), tokenVersion: Number(user.token_version) }), {
        params: t.Object({ id: t.Numeric({ minimum: 1 }) }),
        body: t.Object({ version: t.Integer({ minimum: 1 }) }),
        detail: { summary: `${action} ${resource}`, tags: ["Lifecycle"] },
      });
  }
}
