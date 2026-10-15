import { db } from "..";
import { logger } from "../../utils/logger";
import { SettingInsert, settings } from "../schema/settings";

const setting_lists: SettingInsert[] = [
  {
    name: "low_stock_threshold",
    value: "10",
    created_at: Math.floor(Date.now() / 1000),
    updated_at: Math.floor(Date.now() / 1000),
  },
  {
    name: "high_stock_threshold",
    value: "100",
    created_at: Math.floor(Date.now() / 1000),
    updated_at: Math.floor(Date.now() / 1000),
  },
  {
    name: "refresh_interval_ms",
    value: "30000",
    created_at: Math.floor(Date.now() / 1000),
    updated_at: Math.floor(Date.now() / 1000),
  },
  {
    name: "is_form_validation_debug_enabled",
    value: "true",
    created_at: Math.floor(Date.now() / 1000),
    updated_at: Math.floor(Date.now() / 1000),
  },
  {
    name: "order_limit_per_day",
    value: "10",
    created_at: Math.floor(Date.now() / 1000),
    updated_at: Math.floor(Date.now() / 1000),
  },
  {
    name: "customer_order_limit",
    value: "1",
    created_at: Math.floor(Date.now() / 1000),
    updated_at: Math.floor(Date.now() / 1000),
  },
  {
    name: "max_order_per_vehicle",
    value: "5",
    created_at: Math.floor(Date.now() / 1000),
    updated_at: Math.floor(Date.now() / 1000),
  },
];

export async function settingSeeds() {
  try {
    for (const setting of setting_lists) {
      const insertedSetting = await db
        .insert(settings)
        .values(setting)
        .returning();

      if (!insertedSetting) {
        logger.error("Failed to insert setting into the database");
        return;
      }

      logger.info(`Inserted setting: ${insertedSetting[0].name}`);
    }
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Error seeding settings:", error.message);
    }
  }
}
