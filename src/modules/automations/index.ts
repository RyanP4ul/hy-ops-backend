import { Elysia, t } from "elysia";
import { AutomationService } from "./service";
import { BackupService } from "./backup-service";

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

export const automationRoutes = new Elysia({
  prefix: "/automations",
  detail: { tags: ["Automations"] },
})
  .get("/backup-schedule", () => BackupService.get(), {
    detail: {
      summary: "Get backup schedule",
      description: "Retrieve the configured database backup schedule.",
      tags: ["Automations"],
    },
  })
  .put("/backup-schedule", ({ body }) => BackupService.save(body), {
    body: t.Object({
      enabled: t.Boolean(),
      daily_time: t.String({ pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" }),
      updated_at: t.String({ format: "date-time" }),
    }),
    detail: {
      summary: "Update backup schedule",
      description: "Update the configured database backup schedule.",
      tags: ["Automations"],
    },
  })
  .post("/backup-schedule/run", async () => {
    await BackupService.run(true);
    return { message: "Backup requested. Check GitHub Actions for progress and completion." };
  }, {
    detail: {
      summary: "Run a database backup",
      description: "Request an immediate database backup through GitHub Actions.",
      tags: ["Automations"],
    },
  })
  .get("/", () => AutomationService.list(), {
    detail: {
      summary: "List automations",
      description: "Retrieve all configured automations.",
      tags: ["Automations"],
    },
  })
  .post("/", ({ body }) => AutomationService.create(body), {
    body: t.Object(automationFields),
    detail: {
      summary: "Create an automation",
      description: "Create a scheduled automation.",
      tags: ["Automations"],
    },
  })
  .put("/:id", ({ params, body }) =>
    AutomationService.update(Number(params.id), body), {
      body: t.Partial(t.Object(automationFields)),
      detail: {
        summary: "Update an automation",
        description: "Update an existing automation by its identifier.",
        tags: ["Automations"],
      },
    })
  .post("/:id/toggle", ({ params, body }) =>
    AutomationService.setEnabled(Number(params.id), body.enabled), {
      body: t.Object({ enabled: t.Boolean() }),
      detail: {
        summary: "Toggle an automation",
        description: "Enable or disable an automation by its identifier.",
        tags: ["Automations"],
      },
    })
  .post("/:id/run", ({ params }) =>
    AutomationService.runNow(Number(params.id)), {
      detail: {
        summary: "Run an automation",
        description: "Run an automation immediately by its identifier.",
        tags: ["Automations"],
      },
    });
