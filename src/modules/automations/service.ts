import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db/index";
import {
  AutomationInsert,
  automations,
  AutomationSelect,
} from "@/db/schema/automation";
import { taskManager } from "../../manager/task-manager";
import { configureAutomationTask } from "../../manager/automation-tasks";
import { BACKUP_NAME } from "./backup-workflow";
import { WorkflowError } from "../../utils/workflow-error";
import { reportCadence, reportSchedule, nextReportRun } from "./report-workflow";
import { runReportTask } from "./report-service";

const runtimeTaskNames: Record<string, string> = {
  "Low Stock Checker": "low_stock_checker",
  "Overdue Payment Checker": "overdue_payment_checker",
  "Delivery Follow-up Checker": "delivery_follow_up_checker",
};

function runtimeName(name: string) {
  return runtimeTaskNames[name];
}

export abstract class AutomationService {
  static async list() {
    return await db
      .select()
      .from(automations)
      .orderBy(asc(automations.id));
  }

  static async create(data: AutomationInsert) {
    if (reportCadence(data.name)) throw new WorkflowError("Report tasks are created automatically. Update the existing task.", 400);
    if (data.name === BACKUP_NAME) throw new WorkflowError("Use the GitHub backup schedule controls to manage this task.", 400);
    const [automation] = await db
      .insert(automations)
      .values({
        ...data,
        updated_at: new Date(),
      })
      .returning();

    if (!automation) throw new Error("Failed to create automation.");
    await configureAutomationTask(automation);
    return automation;
  }

  static async update(id: number, data: Partial<AutomationInsert>) {
    const existing = await db.query.automations.findFirst({ where: eq(automations.id, id) });
    const cadence = existing && reportCadence(existing.name);
    if (cadence) {
      if (data.name && data.name !== existing.name) throw new WorkflowError("Scheduled report task names cannot be changed.", 400);
      return db.transaction(async tx => {
        const [lock] = await tx.execute(sql`select pg_try_advisory_xact_lock(${cadence === "weekly" ? 72490182 : 72490183}) as locked`);
        if (!lock?.locked) throw new WorkflowError("Reports are being generated. Try again shortly.", 409);
        const [updated] = await tx.update(automations).set({
          ...data, name: existing.name, interval_ms: null, daily_time: null,
          schedule: reportSchedule(cadence),
          next_run_at: data.status === "DISABLED" ? null : nextReportRun(cadence),
          updated_at: new Date(),
        }).where(eq(automations.id, id)).returning();
        return updated;
      });
    }
    if (data.name && reportCadence(data.name)) throw new WorkflowError("Report task names are reserved.", 400);
    if (existing?.name === BACKUP_NAME || data.name === BACKUP_NAME) throw new WorkflowError("Use the GitHub backup schedule controls to manage this task.", 400);
    const [automation] = await db
      .update(automations)
      .set({ ...data, updated_at: new Date() })
      .where(eq(automations.id, id))
      .returning();

    if (!automation) throw new Error("Automation not found.");
    await configureAutomationTask(automation);
    return automation;
  }

  static async setEnabled(id: number, enabled: boolean) {
    return await this.update(id, {
      status: enabled ? "ENABLED" : "DISABLED",
    });
  }

  static async runNow(id: number) {
    const [automation] = await db
      .select()
      .from(automations)
      .where(eq(automations.id, id));

    if (!automation) throw new Error("Automation not found.");

    if (reportCadence(automation.name)) return runReportTask(automation.name, true);
    const taskName = runtimeName(automation.name);
    if (!taskName || !taskManager.has(taskName)) {
      throw new Error(`Automation "${automation.name}" has no registered task.`);
    }

    await taskManager.runNow(taskName);
    return db.query.automations.findFirst({ where: eq(automations.id, id) });
  }

}
