import { db } from "..";
import { logger } from "../../utils/logger";
import { AutomationInsert, automations } from "../schema/automation";

const automationData: AutomationInsert[] = [
  {
    name: "Low Stock Checker",
    description:
      "Identifies products at or below their configured reorder threshold.",
    schedule: "Every 5 minutes",
    interval_ms: 5 * 60 * 1000,
    status: "ENABLED",
    notes: "Runs against the configured low_stock_threshold setting.",
  },
  {
    name: "Overdue Payment Checker",
    description:
      "Highlights orders with outstanding payments past their due date.",
    schedule: "Every hour",
    interval_ms: 60 * 60 * 1000,
    status: "ENABLED",
    notes: "Checks PAY_ON_DELIVERY and NET_30 payment arrangements.",
  },
  {
    name: "Delivery Follow-up Checker",
    description: "Flags deliveries that may need staff attention.",
    schedule: "Every 10 minutes",
    interval_ms: 10 * 60 * 1000,
    status: "ENABLED",
    notes: "Checks scheduled and in-transit deliveries needing follow-up.",
  },
  {
    name: "Notification Cleanup",
    description: "Represents scheduled cleanup of expired notifications.",
    schedule: "Daily at 02:00",
    daily_time: "02:00",
    status: "DISABLED",
    notes: "Sample automation; no task callback is registered yet.",
  },
  {
    name: "Daily Summary Preview",
    description: "Represents a daily operational summary task.",
    schedule: "Daily at 06:00",
    daily_time: "06:00",
    status: "FAILED",
    notes: "Illustrative failed state for the automation UI.",
    last_error: "Illustrative failed state.",
  },
];

export async function automationSeeds() {
  try {
    await db.transaction(async (tx) => {
      await tx.insert(automations).values(automationData);
    });

    logger.info("Automation seed completed successfully.");
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Error seeding automations:", error.message);
    }

    throw error;
  }
}
