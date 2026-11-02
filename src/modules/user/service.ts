import { revokeLiveSessions } from "../../utils/session-events";
import { WorkflowError } from "../../utils/workflow-error";
import { and, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  deliveries,
  archives,
  audit_logs,
  customer_addresses,
  customers,
  drivers,
  DriverStatus,
  staffs,
  users,
  UserSelect,
  warehouses,
} from "../../db/schema";
import { createAccessToken, createRefreshToken } from "@/plugins/auth";
import bcrypt from "bcrypt";
import { UserType } from "./model";
import { assertOtherAccount, lockUserMutation, UserMutationError, type MutationActor } from "./mutation-policy";

export abstract class UserService {
  static async getMutationActor(id: number) {
    return db.query.users.findFirst({
      columns: { id: true, role: true, token_version: true },
      where: and(eq(users.id, id), eq(users.is_archived, false)),
    });
  }

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

        staff: {
          id: staffs.id,
          warehouse_id: warehouses.id,
          warehouse_name: warehouses.name,
        },

        customer: {
          id: customers.id,
          company_name: customers.company_name,
          address_line: customer_addresses.address_line,
          barangay: customer_addresses.barangay,
          city_municipality: customer_addresses.city_municipality,
          province: customer_addresses.province,
          postal_code: customer_addresses.postal_code,
          phone_number: customers.phone_number,
        },

        driver: {
          id: drivers.id,
          warehouse_id: warehouses.id,
          warehouse_name: warehouses.name,
          status: drivers.status,
          phone_number: drivers.phone_number,
        },
      })
      .from(users)
      .leftJoin(staffs, eq(staffs.user_id, users.id))
      .leftJoin(customers, eq(customers.user_id, users.id))
      .leftJoin(
        customer_addresses,
        and(eq(customer_addresses.customer_id, customers.id), sql`${customer_addresses.id} = (select min(ca.id) from customer_addresses ca where ca.customer_id = ${customers.id})`),
      )
      .leftJoin(drivers, eq(drivers.user_id, users.id))
      .leftJoin(
        warehouses,
        or(
          and(eq(users.role, "staff"), eq(warehouses.id, staffs.warehouse_id)),
          and(eq(users.role, "driver"), eq(warehouses.id, drivers.warehouse_id)),
        ),
      )
      .where(and(is_archived_query, searchQuery))
      .orderBy(desc(users.id))
      .offset(Math.max(page * limit, 0))
      .limit(limit);

    const result = rows.map(({ customer, staff, driver, ...user }) => ({
      ...user,
      profile:
        user.role === "staff"
          ? staff
          : user.role === "customer"
            ? customer
            : user.role === "driver"
              ? driver
              : null,
    }));

    return { rows: result, total: totalResult[0]?.count ?? 0 };
  }

  static async getCustomers(page = 0, limit = 10, search = "", contact?: "phone" | "email") {
    const filters = and(
      eq(users.role, "customer"), eq(users.is_archived, false),
      sql`${customers.id} is not null`,
      search ? or(ilike(users.name, `%${search}%`), ilike(customers.company_name, `%${search}%`), ilike(customers.phone_number, `%${search}%`), ilike(users.email, `%${search}%`)) : undefined,
      contact === "phone" ? sql`nullif(trim(${customers.phone_number}), '') is not null` : contact === "email" ? sql`nullif(trim(${users.email}), '') is not null` : undefined,
    );
    const [total_count] = await db
      .select({ count: count() })
      .from(users)
      .leftJoin(customers, eq(customers.user_id, users.id))
      .where(filters);

    const customers_query = await db
      .select({
        id: customers.id,
        name: users.name,
        company_name: customers.company_name,
        phone_number: customers.phone_number,
        email: users.email,
      })
      .from(users)
      .leftJoin(customers, eq(customers.user_id, users.id))
      .where(filters)
      .orderBy(desc(users.id))
      .offset(Math.max(page * limit, 0))
      .limit(limit);

    const customerIds = customers_query.flatMap((customer) =>
      customer.id === null ? [] : [customer.id],
    );
    const savedAddresses =
      customerIds.length === 0
        ? []
        : await db
            .select({
              id: customer_addresses.id,
              customer_id: customer_addresses.customer_id,
              address_line: customer_addresses.address_line,
              barangay: customer_addresses.barangay,
              city_municipality: customer_addresses.city_municipality,
              province: customer_addresses.province,
              postal_code: customer_addresses.postal_code,
            })
            .from(customer_addresses)
            .where(inArray(customer_addresses.customer_id, customerIds))
            .orderBy(customer_addresses.id);
    const addressesByCustomer = new Map<number, typeof savedAddresses>();
    for (const address of savedAddresses) {
      const customerAddresses =
        addressesByCustomer.get(address.customer_id) ?? [];
      customerAddresses.push(address);
      addressesByCustomer.set(address.customer_id, customerAddresses);
    }

    return {
      rows: customers_query.flatMap((customer) =>
        customer.id === null
          ? []
          : [
              {
                ...customer,
                addresses: addressesByCustomer.get(customer.id) ?? [],
              },
            ],
      ),
      total: total_count?.count ?? 0,
    };
  }

  static async findUserByEmail(email: string): Promise<UserSelect | null> {
    if (!email) return null;

    const user = await db.query.users.findFirst({
      where: and(eq(users.email, email), eq(users.is_archived, false)),
    });

    if (!user) {
      return null;
    }

    return user;
  }

  static async findUserById(id: string): Promise<UserSelect | null> {
    if (!id) return null;

    const user = await db.query.users.findFirst({
      where: and(eq(users.id, Number(id)), eq(users.is_archived, false)),
    });

    if (!user) {
      return null;
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
      throw new WorkflowError("User not found.", 404);
    }

    const profile =
      user.role === "staff"
        ? await this.getUserStaffById(user.id)
        : user.role === "customer"
          ? await this.getUserCustomerById(user.id)
          : user.role === "driver"
            ? await this.getUserDriverById(user.id)
            : null;

    return {
      ...user,
      profile,
    };
  }

  static async getUserStaffById(userId: number) {
    const [staff] = await db
      .select({
        warehouse_id: staffs.warehouse_id,
        warehouse_name: warehouses.name,
      })
      .from(staffs)
      .leftJoin(warehouses, eq(warehouses.id, staffs.warehouse_id))
      .where(eq(staffs.user_id, userId));

    if (!staff) {
      throw new Error("Staff not found.");
    }

    return staff;
  }

  static async getUserCustomerById(userId: number) {
    const customer = await db.query.customers.findFirst({
      columns: {
        user_id: false,
      },
      where: eq(customers.user_id, userId),
    });

    if (!customer) {
      throw new Error("Customer not found.");
    }

    const [address] = await db
      .select({
        address_line: customer_addresses.address_line,
        barangay: customer_addresses.barangay,
        city_municipality: customer_addresses.city_municipality,
        province: customer_addresses.province,
        postal_code: customer_addresses.postal_code,
        latitude: customer_addresses.latitude,
        longitude: customer_addresses.longitude,
      })
      .from(customer_addresses)
      .where(eq(customer_addresses.customer_id, customer.id)).orderBy(customer_addresses.id).limit(1);

    return {
      ...customer,
      ...address,
    };
  }

  static async getUserDriverById(userId: number) {
    // const driver = await db.query.drivers.findFirst({
    //   columns: {
    //     id: false,
    //     user_id: false,
    //   },
    //   where: eq(drivers.user_id, userId),
    // });

    // if (!driver) {
    //   throw new Error("Driver not found.");
    // }

    const [driver] = await db
      .select({
        warehouse_id: drivers.warehouse_id,
        warehouse_name: warehouses.name,
        status: drivers.status,
        phone_number: drivers.phone_number,
      })
      .from(drivers)
      .leftJoin(warehouses, eq(warehouses.id, drivers.warehouse_id))
      .where(eq(drivers.user_id, userId));

    return driver;
  }

  static async createUser(data: UserType, actor: MutationActor) {
    return await db.transaction(async (tx) => {
      await lockUserMutation(tx, actor);
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
        case "staff":
          await tx.insert(staffs).values({
            user_id: user.id,
            warehouse_id: data.profile?.warehouse_id ?? 0,
          });
          break;
        case "customer":
          const [customer] = await tx.insert(customers).values({
            user_id: user.id,
            company_name: data.profile?.company_name ?? "",
            phone_number: data.profile?.phone_number ?? "",
          }).returning({ id: customers.id });

          await tx.insert(customer_addresses).values({
            customer_id: customer.id,
            address_line: data.profile?.address_line ?? "",
            barangay: data.profile?.barangay ?? "",
            city_municipality: data.profile?.city_municipality ?? "",
            province: data.profile?.province ?? "",
            postal_code: data.profile?.postal_code ?? "",
            latitude: data.profile?.latitude ?? "0",
            longitude: data.profile?.longitude ?? "0",
          });
          break;
        case "driver":
          await tx.insert(drivers).values({
            warehouse_id: data.profile?.warehouse_id ?? 0,
            user_id: user.id,
            status: (data.profile?.status ?? "available") as DriverStatus,
            phone_number: data.profile?.phone_number ?? "",
          });
          break;
      }

      return {
        id: user.id,
        message: `User ${user.name} created successfully`,
      };
    });
  }

  static async updateUser(id: number, version: number, data: UserType, actor: MutationActor) {
    let accessChanged = false;
    const result = await db.transaction(async (tx) => {
      await lockUserMutation(tx, actor);
      const [existing_user] = await tx.select().from(users)
        .where(and(eq(users.id, id), eq(users.is_archived, false))).for("update");

      if (!existing_user) {
        throw new Error("User not found.");
      }

      if (existing_user.version !== version) {
        throw new UserMutationError("Version mismatch. Please refresh and try again.");
      }

      if (existing_user.role === "driver" || data.role === "driver") {
        const [profile] = await tx.select().from(drivers).where(eq(drivers.user_id, id)).for("update");
        const [trip] = await tx.select({ id: deliveries.id }).from(deliveries).where(and(eq(deliveries.driver_id, id), inArray(deliveries.status, ["scheduled", "in_transit", "returning"]))).limit(1);
        if (trip && (data.role !== "driver" || data.profile?.status !== profile?.status || data.profile?.warehouse_id !== profile?.warehouse_id)) throw new UserMutationError("Reassign or complete scheduled/active trips before changing the driver's role, status or warehouse.");
        if (data.role === "driver" && data.profile?.status === "on_delivery" && profile?.status !== "on_delivery") throw new UserMutationError("On-delivery driver status is managed by dispatch.");
      }

      accessChanged = existing_user.role !== data.role;
      if (accessChanged) {
        assertOtherAccount(actor.id, id);
      }

      const [user] = await tx
        .update(users)
        .set({
          name: data.name,
          email: data.email,
          role: data.role,
          version: sql`${users.version} + 1`,
          token_version: existing_user.role !== data.role ? sql`${users.token_version} + 1` : users.token_version,
          refresh_token: existing_user.role !== data.role ? null : users.refresh_token,
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
        case "staff": {
          const updated = await tx
            .update(staffs)
            .set({
              warehouse_id: data.profile?.warehouse_id ?? 0,
            })
            .where(eq(staffs.user_id, id)).returning({ id: staffs.id });
          if (!updated.length) await tx.insert(staffs).values({ user_id: id, warehouse_id: data.profile?.warehouse_id ?? 0 });
          break;
        }
        case "customer": {
          let [customer] = await tx
            .update(customers)
            .set({
              company_name: data.profile?.company_name ?? "",
              phone_number: data.profile?.phone_number ?? "",
            })
            .where(eq(customers.user_id, id)).returning({ id: customers.id });
          if (!customer) [customer] = await tx.insert(customers).values({ user_id: id, company_name: data.profile?.company_name ?? "", phone_number: data.profile?.phone_number ?? "" }).returning({ id: customers.id });

          const addressValues = {
              address_line: data.profile?.address_line ?? "",
              barangay: data.profile?.barangay ?? "",
              city_municipality: data.profile?.city_municipality ?? "",
              province: data.profile?.province ?? "",
              postal_code: data.profile?.postal_code ?? "",
              latitude: data.profile?.latitude ?? null,
              longitude: data.profile?.longitude ?? null,
              updated_at: new Date(),
          };
          // The Users form edits the primary (oldest) address. Additional saved
          // destinations must not be overwritten by a profile edit.
          const [address] = await tx.select({ id: customer_addresses.id }).from(customer_addresses)
            .where(eq(customer_addresses.customer_id, customer.id)).orderBy(customer_addresses.id).limit(1);
          if (address) await tx.update(customer_addresses).set(addressValues).where(eq(customer_addresses.id, address.id));
          else await tx.insert(customer_addresses).values({ customer_id: customer.id, ...addressValues });
          break;
        }
        case "driver": {
          const updated = await tx
            .update(drivers)
            .set({
              warehouse_id: data.profile?.warehouse_id ?? 0,
              status: (data.profile?.status ?? "available") as DriverStatus,
              phone_number: data.profile?.phone_number ?? "",
            })
            .where(eq(drivers.user_id, id)).returning({ id: drivers.id });
          if (!updated.length) await tx.insert(drivers).values({ user_id: id, warehouse_id: data.profile?.warehouse_id ?? 0, status: (data.profile?.status ?? "available") as DriverStatus, phone_number: data.profile?.phone_number ?? "" });
          break;
        }
      }

      return {
        message: `User ${user.name} updated successfully`,
      };
    });
    if (accessChanged) revokeLiveSessions(id);
    return result;
  }

  static async changePassword(id: number, password: string, actor: MutationActor) {
    return db.transaction(async (tx) => {
    await lockUserMutation(tx, actor);
    const user = await tx.query.users.findFirst({
      columns: {
        id: true,
        name: true,
        role: true,
      },
      where: and(eq(users.id, id), eq(users.is_archived, false)),
    });

    if (!user) {
      throw new Error("User not found.");
    }

    if (user.role === "customer") {
      return {
        errors: {
          password: "Password changes are not available for customers.",
        },
      };
    }

    const password_hash = await bcrypt.hash(password, 10);

    const [updatedUser] = await tx
      .update(users)
      .set({
        password_hash,
        token_version: sql`${users.token_version} + 1`,
        refresh_token: null,
        updated_at: Math.floor(Date.now() / 1000),
      })
      .where(eq(users.id, id))
      .returning({ name: users.name });

    if (!updatedUser) {
      throw new Error("Failed to change password.");
    }

    return {
      message: `Password for ${updatedUser.name} changed successfully`,
    };
    }).then((result) => { if (!("errors" in result)) revokeLiveSessions(id); return result; });
  }

  static async deleteUser(_id: number, _version: number) {
    // Cascading profile/history foreign keys make hard deletion unsafe until a
    // retention policy and restrictive foreign keys have been deployed.
    throw new UserMutationError("Permanent deletion is disabled to preserve account history. Deactivate the user instead.");
  }

  static async archiveUser(
    archive_id: number,
    target_user_id: number,
    version: number,
    actor: MutationActor,
  ) {
    return db.transaction(async (tx) => {
      await lockUserMutation(tx, actor);
      assertOtherAccount(actor.id, target_user_id);
      const now = Math.floor(Date.now() / 1000);
      const [user] = await tx.update(users).set({
        is_archived: true,
        archived_at: now,
        updated_at: now,
        version: sql`${users.version} + 1`,
        token_version: sql`${users.token_version} + 1`,
        refresh_token: null,
      }).where(and(eq(users.id, target_user_id), eq(users.version, version), eq(users.is_archived, false)))
        .returning({ id: users.id, name: users.name });
      if (!user) throw new UserMutationError("User not found or version mismatch.");
      const [archive] = await tx.insert(archives).values({
        entity_id: String(target_user_id), entity_type: "users",
        archived_by: actor.id, archived_at: now,
      }).returning({ id: archives.id });
      await tx.insert(audit_logs).values({
        user_id: actor.id, action: "USER_DEACTIVATED", entity_type: "users",
        entity_id: String(target_user_id), description: `User ${user.name} deactivated`,
        old_value: JSON.stringify({ is_archived: false }), new_value: JSON.stringify({ is_archived: true }),
        metadata: JSON.stringify({ archiveId: archive.id }), ip_address: "unknown", user_agent: "unknown", created_at: now,
      });
      return { id: archive.id, message: `User ${user.name} deactivated successfully` };
    }).then((result) => { revokeLiveSessions(target_user_id); return result; });
  }

  static async revokeSession(userId: number, tokenVersion: number) {
    const changed = await db.update(users).set({ token_version: sql`${users.token_version} + 1`, refresh_token: null })
      .where(and(eq(users.id, userId), eq(users.token_version, tokenVersion))).returning({ id: users.id });
    if (changed.length) revokeLiveSessions(userId);
  }

  static async rotateSession(userId: number, jwt: any, refreshSigner = jwt) {
    return db.transaction(async (tx) => {
      const [user] = await tx
        .update(users)
        .set({
          token_version: sql`${users.token_version} + 1`,
        })
        .where(and(eq(users.id, userId), eq(users.is_archived, false)))
        .returning();

      if (!user) throw new Error("Account is unavailable.");
      const accessToken = await createAccessToken(jwt, user);
      const refreshToken = await createRefreshToken(refreshSigner, user);

      await tx
        .update(users)
        .set({
          refresh_token: refreshToken,
        })
        .where(eq(users.id, userId));

      return { accessToken, refreshToken };
    }).then((result) => { revokeLiveSessions(userId); return result; });
  }

  static async getAllDrivers(
    page: number = 1,
    limit: number = 10,
    search: string = "",
    warehouse_id: number = -1,
  ) {
    const is_search_empty = search.length === 0;
    const offset = is_search_empty ? Math.max(page * limit, 0) : 0;
    const whereQuery = ilike(users.name, `%${search}%`);

    const [total_result] = await db
      .select({ count: count() })
      .from(users)
      .leftJoin(drivers, eq(drivers.user_id, users.id))
      .where(
        and(
          eq(users.role, "driver"),
          eq(users.is_archived, false),
          eq(drivers.status, "available"),
          is_search_empty ? undefined : whereQuery,
          warehouse_id !== -1
            ? eq(drivers.warehouse_id, warehouse_id)
            : undefined,
        ),
      );

    const drivers_query = await db
      .select({
        id: users.id,
        name: users.name,
        status: drivers.status,
        phone_number: drivers.phone_number,
      })
      .from(users)
      .leftJoin(drivers, eq(drivers.user_id, users.id))
      .where(
        and(
          eq(users.role, "driver"),
          eq(drivers.status, "available"),
          eq(users.is_archived, false),
          is_search_empty ? undefined : whereQuery,
          warehouse_id !== -1
            ? eq(drivers.warehouse_id, warehouse_id)
            : undefined,
        ),
      )
      .orderBy(desc(users.id))
      .offset(offset)
      .limit(limit);

    return {
      rows: drivers_query,
      total: total_result?.count ?? 0,
    };
  }
}
