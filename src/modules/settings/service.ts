import { db } from "@/db/index";
import { settings, SettingSelect } from "@/db/schema/settings";
import { and, eq, inArray } from "drizzle-orm";
import { SettingSchemaType } from "./schema";
import { logger } from "../../utils/logger";

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
    return await db.transaction(async (tx) => {
      for (const setting of setting_changes) {
        logger.silly(
          `Updating setting: ${setting.name} to value: ${setting.value}`,
        );
        const updatedSetting = await tx
          .update(settings)
          .set({ value: setting.value, version: setting.version })
          .where(
            and(
              eq(settings.name, setting.name),
              eq(settings.version, setting.version),
            ),
          );

        if (!updatedSetting) {
          throw new Error(`Setting with name ${setting.name} not found`);
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
