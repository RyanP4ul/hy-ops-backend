import { db } from "..";
import { sql } from "drizzle-orm";
import { tables } from "../table";

import { productSeeds } from "./products";
import { userSeeds } from "./users";
import { settingSeeds } from "./settings";
import { vehicleSeeds } from "./vehicles";
import { calendarSeeds } from "./calendar";
import { automationSeeds } from "./automation";
// import { orderSeeds } from "./orders";

async function run() {
  try {
    // WARNING: Deletes existing records.
    for (const table of Object.keys(tables)) {
      await db.execute(
        sql`TRUNCATE TABLE ${sql.identifier(table)} RESTART IDENTITY CASCADE`,
      );

      console.log(`Truncated table: ${table}`);
    }

    await productSeeds();
    await userSeeds();
    await settingSeeds();
    await vehicleSeeds();
    await calendarSeeds();
    await automationSeeds();
    // await orderSeeds();

    console.log("Database seeding completed successfully.");
  } catch (error) {
    console.error("Database seeding failed:", error);
    process.exitCode = 1;
  }
}

run();
