import { db } from "..";
import { logger } from "../../utils/logger";
import bcrypt from "bcrypt";
import {
  CustomerInsert,
  DriverInsert,
  UserInsert,
  customers,
  drivers,
  users,
} from "../schema";

const user_lists: UserInsert[] = [
  {
    email: "espinola@hyops.com",
    name: "Ryan Paul",
    password_hash: "123456",
    role: "admin",
    created_at: Math.floor(Date.now() / 1000),
    updated_at: Math.floor(Date.now() / 1000),
  },
  {
    email: "paring@hyops.com",
    name: "Ivan",
    password_hash: "123456",
    role: "staff",
    created_at: Math.floor(Date.now() / 1000),
    updated_at: Math.floor(Date.now() / 1000),
  },
  {
    email: "cunanan@hyops.com",
    name: "Miguel",
    password_hash: "123456",
    role: "customer",
    created_at: Math.floor(Date.now() / 1000),
    updated_at: Math.floor(Date.now() / 1000),
  },
  {
    email: "belmonte@hyops.com",
    name: "Jhon Elizer",
    password_hash: "123456",
    role: "driver",
    created_at: Math.floor(Date.now() / 1000),
    updated_at: Math.floor(Date.now() / 1000),
  },
];

export async function userSeeds() {
  try {
    for (const user of user_lists) {
      const password_hash = await bcrypt.hash(user.password_hash, 10);
      user.password_hash = password_hash;

      const insertedUser = await db.insert(users).values(user).returning();

      if (!insertedUser) {
        logger.error("Failed to insert user into the database");
        return;
      }

      if (user.role === "customer") {
        const customer: CustomerInsert = {
          user_id: insertedUser[0].id,
          company_name: "Light",
          address: "STI College Balagtas",
          phone_number: "+63-555-0100",
        };

        await db.insert(customers).values(customer);
      }

      if (user.role === "driver") {
        const driver: DriverInsert = {
          user_id: insertedUser[0].id,
          phone_number: "+1-555-0200",
        };

        await db.insert(drivers).values(driver);
      }

      logger.info(`Inserted user: ${insertedUser[0].email}`);
    }
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Error seeding users:", error.message);
    }
  }
}
