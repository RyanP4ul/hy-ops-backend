import { asc, eq } from "drizzle-orm";
import { db } from "@/db/index";
import {
  AutomationInsert,
  automations,
  AutomationSelect,
} from "@/db/schema/automation";
import { taskManager } from "../../manager/task-manager";
import { configureAutomationTask } from "../../manager/automation-tasks";

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

    const taskName = runtimeName(automation.name);
    if (!taskName || !taskManager.has(taskName)) {
      throw new Error(`Automation "${automation.name}" has no registered task.`);
    }

    await taskManager.runNow(taskName);
    const [updated] = await db
      .update(automations)
      .set({ last_run_at: new Date(), last_error: null, updated_at: new Date() })
      .where(eq(automations.id, id))
      .returning();

    return updated;
  }

}
