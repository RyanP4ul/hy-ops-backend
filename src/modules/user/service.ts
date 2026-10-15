import { and, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  customers,
  drivers,
  DriverStatus,
  users,
  UserSelect,
} from "../../db/schema";
import { createAccessToken, createRefreshToken } from "@/plugins/auth";
import bcrypt from "bcrypt";
import { UserType } from "./model";
import { ArchiveService } from "../archives/service";

export abstract class UserService {
  static async getUsers(page = 0, limit = 10, search = "") {
    const is_archived_query = eq(users.is_archived, false);

    const searchQuery = search
      ? or(ilike(users.name, `%${search}%`), ilike(users.email, `%${search}%`))
      : undefined;

    const totalResult = await db
      .select({ count: count() })
      .from(users)
      .where(and(is_archived_query, searchQuery));

    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        last_login: users.last_login,
        version: users.version,

        customer: {
          id: customers.id,
          company_name: customers.company_name,
          address: customers.address,
          phone_number: customers.phone_number,
        },

        driver: {
          id: drivers.id,
          status: drivers.status,
          phone_number: drivers.phone_number,
        },
      })
      .from(users)
      .leftJoin(customers, eq(customers.user_id, users.id))
      .leftJoin(drivers, eq(drivers.user_id, users.id))
      .where(and(is_archived_query, searchQuery))
      .orderBy(desc(users.id))
      .offset(Math.max(page * limit, 0))
      .limit(limit);

    const result = rows.map(({ customer, driver, ...user }) => ({
      ...user,
      profile:
        user.role === "customer"
          ? customer
          : user.role === "driver"
            ? driver
            : null,
    }));

    return { rows: result, total: totalResult[0]?.count ?? 0 };
  }

  static async getCustomers(page = 0, limit = 10) {
    const [total_count] = await db
      .select({ count: count() })
      .from(users)
      .where(and(eq(users.role, "customer"), eq(users.is_archived, false)));

    const customers_query = await db
      .select({
        id: customers.id,
        name: users.name,
        company_name: customers.company_name,
        address: customers.address,
      })
      .from(users)
      .leftJoin(customers, eq(customers.user_id, users.id))
      .where(and(eq(users.role, "customer"), eq(users.is_archived, false)))
      .orderBy(desc(users.id))
      .offset(Math.max(page * limit, 0))
      .limit(limit);

    return {
      rows: customers_query,
      total: total_count?.count ?? 0,
      test: true,
    };
  }

  static async findUserByEmail(email: string): Promise<UserSelect | null> {
    if (!email) return null;

    const user = await db.query.users.findFirst({
      where: and(eq(users.email, email), eq(users.is_archived, false)),
    });

    if (!user) {
      throw new Error("Invalid credentials.");
    }

    return user;
  }

  static async findUserById(id: string): Promise<UserSelect | null> {
    if (!id) return null;

    const user = await db.query.users.findFirst({
      where: and(eq(users.id, Number(id)), eq(users.is_archived, false)),
    });

    if (!user) {
      throw new Error("User not found.");
    }

    return user;
  }

  static async getUserById(id: number) {
    const user = await db.query.users.findFirst({
      columns: {
        token_version: false,
        refresh_token: false,
        password_hash: false,
        created_at: false,
        updated_at: false,
        last_login: false,
      },
      where: and(eq(users.id, id), eq(users.is_archived, false)),
    });

    if (!user) {
      throw new Error("User not found.");
    }

    const profile =
      user.role === "customer"
        ? await this.getUserCustomerById(user.id)
        : user.role === "driver"
          ? await this.getUserDriverById(user.id)
          : null;

    return {
      ...user,
      profile,
    };
  }

  static async getUserCustomerById(userId: number) {
    const customer = await db.query.customers.findFirst({
      columns: {
        id: false,
        user_id: false,
      },
      where: eq(customers.user_id, userId),
    });

    if (!customer) {
      throw new Error("Customer not found.");
    }

    return customer;
  }

  static async getUserDriverById(userId: number) {
    const driver = await db.query.drivers.findFirst({
      columns: {
        id: false,
        user_id: false,
      },
      where: eq(drivers.user_id, userId),
    });

    if (!driver) {
      throw new Error("Driver not found.");
    }

    return driver;
  }

  static async createUser(data: UserType) {
    return await db.transaction(async (tx) => {
      const password_hash = data.password
        ? await bcrypt.hash(data.password, 10)
        : null;

      if (!password_hash) {
        return {
          errors: {
            password: "Password is required.",
          },
        };
      }

      const now = Math.floor(Date.now() / 1000);

      const [user] = await tx
        .insert(users)
        .values({
          name: data.name,
          email: data.email,
          password_hash: password_hash,
          role: data.role,
          created_at: now,
          updated_at: now,
        })
        .returning({
          id: users.id,
          name: users.name,
        });

      if (!user) {
        throw new Error("Failed to create user.");
      }

      switch (data.role) {
        case "customer":
          await tx.insert(customers).values({
            user_id: user.id,
            company_name: data.profile?.company_name ?? "",
            phone_number: data.profile?.phone_number ?? "",
            address: data.profile?.address ?? "",
          });
          break;
        case "driver":
          await tx.insert(drivers).values({
            user_id: user.id,
            status: (data.profile?.status ?? "available") as DriverStatus,
            phone_number: data.profile?.phone_number ?? "",
          });
          break;
      }

      return {
        message: `User ${user.name} created successfully`,
      };
    });
  }

  static async updateUser(id: number, version: number, data: UserType) {
    return await db.transaction(async (tx) => {
      const existing_user = await tx.query.users.findFirst({
        where: and(eq(users.id, id), eq(users.is_archived, false)),
      });

      if (!existing_user) {
        throw new Error("User not found.");
      }

      if (existing_user.version !== version) {
        throw new Error("Version mismatch. Please refresh and try again.");
      }

      const [user] = await tx
        .update(users)
        .set({
          name: data.name,
          email: data.email,
          role: data.role,
          updated_at: Math.floor(Date.now() / 1000),
        })
        .where(eq(users.id, id))
        .returning({
          id: users.id,
          name: users.name,
        });

      if (!user) {
        throw new Error("Failed to update user.");
      }

      switch (data.role) {
        case "customer":
          await tx
            .update(customers)
            .set({
              company_name: data.profile?.company_name ?? "",
              phone_number: data.profile?.phone_number ?? "",
              address: data.profile?.address ?? "",
            })
            .where(eq(customers.user_id, id));
          break;
        case "driver":
          await tx
            .update(drivers)
            .set({
              status: (data.profile?.status ?? "available") as DriverStatus,
              phone_number: data.profile?.phone_number ?? "",
            })
            .where(eq(drivers.user_id, id));
          break;
      }

      return {
        message: `User ${user.name} updated successfully`,
      };
    });
  }

  static async deleteUser(id: number, version: number) {
    return await db.transaction(async (tx) => {
      const user = await tx.query.users.findFirst({
        where: and(
          eq(users.id, id),
          eq(users.version, version),
          eq(users.is_archived, false),
        ),
      });

      if (!user) {
        throw new Error("User not found or version mismatch.");
      }

      await tx.delete(users).where(eq(users.id, id));

      return {
        message: `User ${user.name} deleted successfully`,
      };
    });
  }

  static async archiveUser(
    archive_id: number,
    target_user_id: number,
    version: number,
  ) {
    return await db.transaction(async (tx) => {
      const user = await tx.query.users.findFirst({
        where: and(
          eq(users.id, target_user_id),
          eq(users.version, version),
          eq(users.is_archived, false),
        ),
      });

      if (!user) {
        throw new Error("User not found or version mismatch.");
      }

      const result = await tx
        .update(users)
        .set({
          is_archived: true,
          archived_at: Math.floor(Date.now() / 1000),
        })
        .where(eq(users.id, target_user_id));

      if (!result) {
        throw new Error("Failed to archive user.");
      }

      const { id: archiveId } = await ArchiveService.createArchive({
        entity_id: String(target_user_id),
        entity_type: "users",
        archived_by: archive_id,
      });

      return {
        id: archiveId,
        message: `User ${user.name} archived successfully`,
      };
    });
  }

  static async rotateSession(userId: number, jwt: any) {
    return db.transaction(async (tx) => {
      const [user] = await tx
        .update(users)
        .set({
          token_version: sql`${users.token_version} + 1`,
        })
        .where(eq(users.id, userId))
        .returning();

      const accessToken = await createAccessToken(jwt, user);
      const refreshToken = await createRefreshToken(jwt, user);

      await tx
        .update(users)
        .set({
          refresh_token: refreshToken,
        })
        .where(eq(users.id, userId));

      return { accessToken, refreshToken };
    });
  }
}
