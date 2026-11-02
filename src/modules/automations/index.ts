import { Elysia, t } from "elysia";
import { AutomationService } from "./service";

const automationFields = {
  name: t.String({ minLength: 1, maxLength: 100 }),
  description: t.String({ minLength: 1 }),
  schedule: t.String({ minLength: 1, maxLength: 100 }),
  interval_ms: t.Optional(t.Nullable(t.Integer({ minimum: 1 }))),
  daily_time: t.Optional(t.Nullable(t.String({ pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }))),
  status: t.Optional(t.Union([
    t.Literal("ENABLED"),
    t.Literal("DISABLED"),
    t.Literal("FAILED"),
  ])),
  notes: t.Optional(t.Nullable(t.String())),
};

export const automationRoutes = new Elysia({ prefix: "/automations" })
  .get("/", () => AutomationService.list())
  .post("/", ({ body }) => AutomationService.create(body), {
    body: t.Object(automationFields),
  })
  .put("/:id", ({ params, body }) =>
    AutomationService.update(Number(params.id), body), {
      body: t.Partial(t.Object(automationFields)),
    })
  .post("/:id/toggle", ({ params, body }) =>
    AutomationService.setEnabled(Number(params.id), body.enabled), {
      body: t.Object({ enabled: t.Boolean() }),
    })
  .post("/:id/run", ({ params }) =>
    AutomationService.runNow(Number(params.id)));
