import { asc, eq } from "drizzle-orm";
import { customers, products, users, vehicles, warehouses } from "@/db/schema";
import type { OptionsResponse } from "../reports.contract";
import { db } from "@/db/index";

/** Choices for the filter dropdowns. */
export async function findFilterOptions(): Promise<OptionsResponse> {
  const [cu, pr, wh, ve] = await Promise.all([
    db
      .select({
        id: customers.id,
        company: customers.company_name,
        contact: users.name,
      })
      .from(customers)
      .innerJoin(users, eq(customers.user_id, users.id)),
    db
      .select({ id: products.id, name: products.name })
      .from(products)
      .orderBy(asc(products.name)),
    db
      .select({ id: warehouses.id, name: warehouses.name })
      .from(warehouses)
      .orderBy(asc(warehouses.name)),
    db
      .select({ plate: vehicles.plate_number })
      .from(vehicles)
      .orderBy(asc(vehicles.plate_number)),
  ]);
  return {
    customers: cu
      .map((c) => ({
        value: String(c.id),
        label: c.company !== "none" ? c.company : c.contact,
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    products: pr.map((p) => ({ value: String(p.id), label: p.name })),
    warehouses: wh.map((w) => ({ value: String(w.id), label: w.name })),
    vehicles: ve.map((v) => ({ value: v.plate, label: v.plate })),
  };
}
