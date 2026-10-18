import { db } from "..";
import * as schema from "../../db/schema";
import { tables } from "../table";
import { orderSeeds } from "./orders";
import { productSeeds } from "./products";
import { settingSeeds } from "./settings";
import { userSeeds } from "./users";
import { vehicleSeeds } from "./vehicles";
import { calendarSeeds } from "./calendar";

async function run() {
  for (const table of Object.keys(tables) as (keyof typeof tables)[]) {
    try {
      await db.execute(`TRUNCATE TABLE ${table} RESTART IDENTITY CASCADE`);
      console.log(`Deleted all records from ${table}`);
    } catch (error) {
      console.error(`Error deleting records from ${table}:`, error);
    }
  }

  await productSeeds();
  await userSeeds();
  await settingSeeds();
  await vehicleSeeds();
  await calendarSeeds();
  // await orderSeeds();
}

run();
