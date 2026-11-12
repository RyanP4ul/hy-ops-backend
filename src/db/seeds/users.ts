import { db } from "..";
import { logger } from "../../utils/logger";
import bcrypt from "bcrypt";
import {
  CustomerInsert,
  DriverInsert,
  StaffInsert,
  UserInsert,
  customers,
  customer_addresses,
  drivers,
  staffs,
  users,
} from "../schema";

const customerRecords: Record<
  string,
  {
    name: string;
    company_name: string;
    phone_number: string;
    address_line: string;
    barangay: string;
    city_municipality: string;
    province: string;
    postal_code: string;
    latitude: string;
    longitude: string;
  }
> = {
  "cunanan@hyops.com": {
    name: "Miguel Cunanan",
    company_name: "Light Trading Co.",
    phone_number: "+63-555-0101",
    address_line: "McArthur Highway",
    barangay: "Ilang-Ilang",
    city_municipality: "Guiguinto",
    province: "Bulacan",
    postal_code: "3015",
    latitude: "14.8325",
    longitude: "120.8822",
  },
  "silang@hyops.com": {
    name: "Ramon Silang",
    company_name: "Silang Supplies",
    phone_number: "+63-555-0102",
    address_line: "Rizal Street",
    barangay: "San Jose",
    city_municipality: "Malolos",
    province: "Bulacan",
    postal_code: "3025",
    latitude: "14.8430",
    longitude: "120.8110",
  },
  "gonzales@hyops.com": {
    name: "Carlos Gonzales",
    company_name: "Gonzales Logistics",
    phone_number: "+63-555-0103",
    address_line: "Sampaga Street",
    barangay: "Poblacion",
    city_municipality: "Bocaue",
    province: "Bulacan",
    postal_code: "3024",
    latitude: "14.7980",
    longitude: "120.9260",
  },
  "ruiz@hyops.com": {
    name: "Antonio Ruiz",
    company_name: "Ruiz Hardware",
    phone_number: "+63-555-0104",
    address_line: "Quezon Avenue",
    barangay: "Bagong Silang",
    city_municipality: "Malolos City",
    province: "Bulacan",
    postal_code: "3025",
    latitude: "14.8435",
    longitude: "120.8100",
  },
  "delacruz@hyops.com": {
    name: "Maria Delacruz",
    company_name: "Delacruz Enterprises",
    phone_number: "+63-555-0105",
    address_line: "M.H. Del Pilar Street",
    barangay: "Santa Maria",
    city_municipality: "Hagonoy",
    province: "Bulacan",
    postal_code: "3035",
    latitude: "14.8320",
    longitude: "120.7320",
  },
  "mejia@hyops.com": {
    name: "Jose Mejia",
    company_name: "Mejia Industrial Supplies",
    phone_number: "+63-555-0106",
    address_line: "Jose Abad Santos Street",
    barangay: "Maypangue",
    city_municipality: "Balagtas",
    province: "Bulacan",
    postal_code: "3016",
    latitude: "14.8150",
    longitude: "120.9060",
  },
};

const user_lists: UserInsert[] = [
  {
    email: "espinola@hyops.com",
    name: "Ryan Paul Espinola",
    password_hash: "123456",
    role: "admin",
    created_at: Math.floor(Date.now() / 1000),
    updated_at: Math.floor(Date.now() / 1000),
  },
  {
    email: "paring@hyops.com",
    name: "Ivan Paring",
    password_hash: "123456",
    role: "staff",
    created_at: Math.floor(Date.now() / 1000),
    updated_at: Math.floor(Date.now() / 1000),
  },
  ...Object.entries(customerRecords).map(([email, data]) => ({
    email: email,
    name: data.name || "Unknown",
    password_hash: "123456",
    role: "customer" as const,
    created_at: Math.floor(Date.now() / 1000),
    updated_at: Math.floor(Date.now() / 1000),
  })),
  {
    email: "belmonte@hyops.com",
    name: "Jhon Elizer Belmonte",
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

      if (user.role === "staff") {
        const staff: StaffInsert = {
          user_id: insertedUser[0].id,
          warehouse_id: 1,
        };

        await db.insert(staffs).values(staff);
      }

      if (user.role === "customer") {
        const customerData = customerRecords[user.email];

        if (!customerData) {
          logger.error(`Missing customer data for ${user.email}`);
          continue;
        }

        const {
          company_name,
          phone_number,
          address_line,
          barangay,
          city_municipality,
          province,
          postal_code,
          latitude,
          longitude,
        } = customerData;

        const customer: CustomerInsert = {
          user_id: insertedUser[0].id,
          company_name,
          phone_number,
        };

        const insertedCustomer = await db
          .insert(customers)
          .values(customer)
          .returning();

        await db.insert(customer_addresses).values({
          customer_id: insertedCustomer[0].id,
          address_line,
          barangay,
          city_municipality,
          province,
          postal_code,
          latitude,
          longitude,
        });
      }

      if (user.role === "driver") {
        const driver: DriverInsert = {
          user_id: insertedUser[0].id,
          warehouse_id: 1,
          phone_number: "639482734769",
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
