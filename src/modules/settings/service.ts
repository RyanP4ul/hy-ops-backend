import { db } from "@/db/index";
import { settings, SettingSelect } from "@/db/schema/settings";
import { and, eq, inArray } from "drizzle-orm";
import { SettingSchemaType } from "./schema";
import { logger } from "../../utils/logger";
import { parseWarehouseArrivalRadius, WAREHOUSE_ARRIVAL_RADIUS_M, WAREHOUSE_ARRIVAL_SETTING } from "../deliveries/warehouse-arrival";
import { WorkflowError } from "../../utils/workflow-error";

const MOBILE_REFRESH_SETTING = "mobile_automatic_refresh_interval_ms";
const MOBILE_REFRESH_DEFAULT = "30000";

export abstract class SettingService {
  static async getAllSettings() {
    const settings = await db.query.settings.findMany({
      columns: {
        created_at: false,
        updated_at: false,
      },
    });

    const settingsMap: Record<
      string,
      Omit<SettingSelect, "name" | "created_at" | "updated_at">
    > = {};

    for (const setting of settings) {
      settingsMap[setting.name] = setting;
    }

    // Existing installations can display and save the new setting without reseeding.
    settingsMap[WAREHOUSE_ARRIVAL_SETTING] ??= { id: 0, value: String(WAREHOUSE_ARRIVAL_RADIUS_M), version: 1 };
    settingsMap[MOBILE_REFRESH_SETTING] ??= { id: 0, value: MOBILE_REFRESH_DEFAULT, version: 1 };

    return settingsMap;
  }

  static getSettingByNames(names: string[]) {
    return db.query.settings.findMany({
      columns: {
        created_at: false,
        updated_at: false,
      },
      where: inArray(settings.name, names),
    });
  }

  static async updateSetting(setting_changes: Omit<SettingSchemaType, "id">[]) {
    for (const setting of setting_changes) {
      if (setting.name === MOBILE_REFRESH_SETTING && (!/^\d+$/.test(setting.value) || !Number.isInteger(Number(setting.value)) || Number(setting.value) < 1 || Number(setting.value) > 2147483647)) {
        throw new WorkflowError("Mobile automatic refresh interval must be a whole number from 1 to 2147483647 milliseconds.", 400);
      }
      if (setting.name === WAREHOUSE_ARRIVAL_SETTING && parseWarehouseArrivalRadius(setting.value) === null) {
        throw new WorkflowError("Automatic return confirmation distance must be a whole number from 50 to 1000 metres.", 400);
      }
    }
    return await db.transaction(async (tx) => {
      for (const setting of setting_changes) {
        if (setting.name === WAREHOUSE_ARRIVAL_SETTING || setting.name === MOBILE_REFRESH_SETTING) {
          const now = Math.floor(Date.now() / 1000);
          const defaultValue = setting.name === WAREHOUSE_ARRIVAL_SETTING ? String(WAREHOUSE_ARRIVAL_RADIUS_M) : MOBILE_REFRESH_DEFAULT;
          await tx.insert(settings).values({ name: setting.name, value: defaultValue, created_at: now, updated_at: now })
            .onConflictDoNothing({ target: settings.name });
        }
        logger.silly(
          `Updating setting: ${setting.name} to value: ${setting.value}`,
        );
        const [updatedSetting] = await tx
          .update(settings)
          .set({
            value: setting.value,
            version: setting.version + 1,
            updated_at: Math.floor(Date.now() / 1000),
          })
          .where(
            and(
              eq(settings.name, setting.name),
              eq(settings.version, setting.version),
            ),
          )
          .returning({ name: settings.name });

        if (!updatedSetting) {
          throw new Error(
            `Setting ${setting.name} was not found or has been modified. Please refresh and try again.`,
          );
        }
      }

      return {
        message: "Settings updated successfully",
      };
    });

    // const setting = await db.query.settings.findFirst({
    //   where: (settings, { eq }) => eq(settings.name, name),
    // });
    //
    // if (!setting) {
    //   throw new Error(`Setting with name ${name} not found`);
    // }
    //
    // return db.update(settings)
    //   .set({ value })
    //   .where((settings, { eq }) => eq(settings.name, name))
    //   .returning();
  }
}

export const settingService = SettingService;
