import { assertOperationalOrder } from "../lifecycle/order-eligibility";
import { activeInventory } from "../lifecycle/availability";
import { activeUser, activeWarehouse } from "../lifecycle/availability";
import { createHash } from "node:crypto";
import { WorkflowError } from "../../utils/workflow-error";
import { stockTransaction, type StockTransaction } from "../inventory/transaction";
import type { CreateOrderInput, OrderBatchInput, OrderEditInput, WalkInOrderInput } from "./model";
import { allocatePayment } from "../../utils/payment-allocation";
import { coordinates } from "../../utils/coordinates";
import { changeOrderStock } from "./stock";
import { assertNoExternalClaim } from "../lalamove/fulfillment";
import { db } from "@/db/index";
import {
  customer_addresses,
  customers,
  inventory,
  payments,
  payment_groups,
  payment_group_allocations,
  deliveries,
  deliveries_stops,
  product_variants,
  products,
  users,
  vehicles,
  warehouses,
} from "@/db/schema";
import { order_items, orders, order_groups } from "@/db/schema/order";
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  or,
  sql,
} from "drizzle-orm";
import { getOrderCombinedPayment } from "../payments/groups";
import { PaymentService } from "../payments/service";
import { PaymentMethodType } from "@/db/schema/payment";
import { InvoiceService } from "../invoice/service";
import { invoices } from "@/db/schema/invoice";
import { minorUnitsToMoney, moneyToMinorUnits } from "../../utils/money";

export const WALK_IN_SYSTEM_EMAIL = "walkin@system.local";

const orderGroupFields = {
  order_group_id: orders.order_group_id,
  order_group_position: orders.order_group_position,
  order_group_number: sql<string | null>`(select group_number from order_groups where id = ${orders.order_group_id})`,
  order_group_size: sql<number>`(select count(*)::int from orders as members where members.order_group_id = ${orders.order_group_id})`.mapWith(Number),
};
const internalSchedulingEligible = sql`coalesce(${orders.delivery_method}, '') not in ('LALAMOVE', 'WALK_IN')
  and not exists (select 1 from delivery_orders b where b.order_id = ${orders.id} and b.active)
  and not exists (select 1 from delivery_order_stops s where s.order_id = ${orders.id} and s.active)
  and not exists (select 1 from orders m where m.order_group_id = ${orders.order_group_id}
    and m.status <> 'CANCELLED'
    and (m.delivery_method in ('LALAMOVE', 'WALK_IN')
      or exists (select 1 from delivery_orders b where b.order_id = m.id and b.active)
      or exists (select 1 from delivery_order_stops s where s.order_id = m.id and s.active)))`;

const resolvedCustomerNameSql = sql<string>`case when ${orders.sales_channel} = 'WALK_IN' and coalesce(nullif(trim(${orders.shipping_recipient}), ''), '') <> '' then ${orders.shipping_recipient} else ${users.name} end`;

type SortField = "id" | "product_number" | "warehouse_name" | "customer_name" | "item_count" | "total";
type SortOrder = "asc" | "desc";

function formatShippingAddress(address: {
  address_line: string;
  barangay: string;
  city_municipality: string;
  province: string;
  postal_code: string | null;
}): string {
  return [
    address.address_line,
    address.barangay,
    address.city_municipality,
    address.province,
    address.postal_code,
  ]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join(", ");
}

function calculateOrderTotal(
  items: { quantity: number; price: string | null }[],
): number | null {
  if (items.some((item) => item.price === null)) return null;

  const totalMinor = items.reduce(
    (total, item) =>
      total +
      moneyToMinorUnits(item.price ?? "0") * BigInt(item.quantity),
    0n,
  );
  return Number(minorUnitsToMoney(totalMinor));
}

const ACTIVE_ORDER_STATUSES = [
  "PENDING",
  "PROCESSING",
  "SCHEDULING",
  "SCHEDULED",
  "IN_TRANSIT",
] as const;

export type CustomerOrderEligibility = {
  eligible: boolean;
  reasonCode: null;
  activeOrderCount: number;
  // Retained for older clients; customer order counts no longer impose a limit.
  maxActiveOrders: null;
  checkedAt: string;
  message: string | null;
};

function buildCustomerOrderEligibility(
  activeOrderCount: number,
): CustomerOrderEligibility {
  return {
    eligible: true,
    reasonCode: null,
    activeOrderCount,
    maxActiveOrders: null,
    checkedAt: new Date().toISOString(),
    message: null,
  };
}

export abstract class OrderService {
  private static async getOrCreateWalkInCustomer(tx: StockTransaction) {
    const nowSec = Math.floor(Date.now() / 1000);
    await tx
      .insert(users)
      .values({
        email: WALK_IN_SYSTEM_EMAIL,
        name: "Walk-in Customer",
        password_hash: "!system-walk-in-disabled!",
        role: "customer",
        is_archived: false,
        created_at: nowSec,
        updated_at: nowSec,
      })
      .onConflictDoNothing({ target: users.email });

    const [sysUser] = await tx
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.email, WALK_IN_SYSTEM_EMAIL))
      .for("update");
    if (!sysUser) throw new WorkflowError("Failed to initialize system walk-in customer.");

    const [existingCustomer] = await tx
      .select({ id: customers.id, phone_number: customers.phone_number })
      .from(customers)
      .where(eq(customers.user_id, sysUser.id))
      .for("update");

    if (existingCustomer) {
      return {
        id: existingCustomer.id,
        name: sysUser.name,
        phone_number: existingCustomer.phone_number,
      };
    }

    const [createdCustomer] = await tx
      .insert(customers)
      .values({
        user_id: sysUser.id,
        company_name: "Walk-in Counter",
        phone_number: "N/A",
      })
      .returning({ id: customers.id, phone_number: customers.phone_number });

    if (!createdCustomer) throw new WorkflowError("Failed to create system walk-in customer profile.");
    return {
      id: createdCustomer.id,
      name: sysUser.name,
      phone_number: createdCustomer.phone_number,
    };
  }

  private static async insertOrderItemsWithPriceSnapshot(
    tx: StockTransaction,
    orderId: number,
    items: { inventory_id: number; quantity: number }[],
  ) {
    const currentPrices = await tx
      .select({
        inventory_id: inventory.id,
        price: product_variants.price,
        cost_price: product_variants.cost_price,
      })
      .from(inventory)
      .innerJoin(
        product_variants,
        eq(inventory.product_variant_id, product_variants.id),
      )
      .where(
        and(activeInventory(), inArray(
          inventory.id,
          [...new Set(items.map((item) => item.inventory_id))],
        )),
      )
      .orderBy(asc(inventory.id))
      .for("update");
    const priceByInventory = new Map(
      currentPrices.map((row) => [
        row.inventory_id,
        { price: row.price, cost_price: row.cost_price },
      ]),
    );

    for (const item of items) {
      const current = priceByInventory.get(item.inventory_id);
      if (current === undefined) {
        throw new WorkflowError(
          `Inventory item ${item.inventory_id} is unavailable for this order.`,
        );
      }
      const unitPriceSnapshot = minorUnitsToMoney(
        moneyToMinorUnits(current.price),
      );
      const unitCostSnapshot =
        current.cost_price !== null
          ? minorUnitsToMoney(moneyToMinorUnits(current.cost_price))
          : null;

      const [order_item] = await tx
        .select()
        .from(order_items)
        .where(
          and(
            eq(order_items.order_id, orderId),
            eq(order_items.inventory_id, item.inventory_id),
          ),
        );

      if (order_item) {
        await tx
          .update(order_items)
          .set({
            quantity: order_item.quantity + item.quantity,
          })
          .where(
            and(
              eq(order_items.order_id, orderId),
              eq(order_items.inventory_id, item.inventory_id),
            ),
          );
      } else {
        await tx.insert(order_items).values({
          order_id: orderId,
          inventory_id: item.inventory_id,
          quantity: item.quantity,
          unit_price_snapshot: unitPriceSnapshot,
          unit_cost_snapshot: unitCostSnapshot,
          price_source: "checkout",
        });
      }
    }
  }

  private static async computeOrderTotalMinor(tx: StockTransaction, orderId: number): Promise<bigint> {
    const [orderTotal] = await tx
      .select({
        total: sql<string>`coalesce(sum(${order_items.quantity} * ${order_items.unit_price_snapshot}), 0)`,
      })
      .from(order_items)
      .where(eq(order_items.order_id, orderId));
    return moneyToMinorUnits(orderTotal?.total ?? "0");
  }

  static async getCustomerAddresses(customerId: number) {
    const [customer] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.id, customerId));
    if (!customer) throw new WorkflowError("Customer not found.", 404);
    const rows = await db
      .select({
        id: customer_addresses.id,
        customer_id: customer_addresses.customer_id,
        address_line: customer_addresses.address_line,
        barangay: customer_addresses.barangay,
        city_municipality: customer_addresses.city_municipality,
        province: customer_addresses.province,
        postal_code: customer_addresses.postal_code,
        latitude: customer_addresses.latitude,
        longitude: customer_addresses.longitude,
      })
      .from(customer_addresses)
      .where(eq(customer_addresses.customer_id, customerId))
      .orderBy(asc(customer_addresses.id));
    return { rows };
  }

  static async saveShippingAddress(customerId: number, data: import("./model").SavedShippingAddress) {
    const point = coordinates(data.latitude, data.longitude);
    if (!point) throw new WorkflowError("Confirm valid coordinates for this shipping address.");
    return stockTransaction(async (tx) => {
      const [customer] = await tx.select({ id: customers.id }).from(customers)
        .innerJoin(users, eq(users.id, customers.user_id))
        .where(and(eq(customers.id, customerId), activeUser()))
        .for("update", { of: customers });
      if (!customer) throw new WorkflowError("Choose an active customer.");
      const [address] = await tx.insert(customer_addresses).values({
        customer_id: customerId,
        address_line: data.address_line.trim(),
        barangay: data.barangay.trim(),
        city_municipality: data.city_municipality.trim(),
        province: data.province.trim(),
        postal_code: data.postal_code?.trim() || null,
        latitude: String(point.latitude),
        longitude: String(point.longitude),
      }).returning();
      return address;
    });
  }

  static async getCustomerOrderEligibility(customerId: number) {
    const [customer] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.id, customerId));

    if (!customer) throw new WorkflowError("Customer not found.");

    const [activeOrders] = await db
      .select({ count: count() })
      .from(orders)
      .where(and(
        eq(orders.customer_id, customerId),
        inArray(orders.status, ACTIVE_ORDER_STATUSES),
      ));

    return buildCustomerOrderEligibility(
      activeOrders?.count ?? 0,
    );
  }

  static async getOrderTableRowById(id: number) {
    const [row] = await db
      .select({
        id: orders.id,
        product_number: orders.order_number,
        ...orderGroupFields,
        sales_channel: orders.sales_channel,
        customer_name: resolvedCustomerNameSql,
        customer_company: customers.company_name,
        shipping_address: orders.shipping_address,
        status: orders.status,
        delivery_type: sql<string>`coalesce(${orders.delivery_method}, (select ${deliveries.delivery_type}::text from ${deliveries_stops} inner join ${deliveries} on ${deliveries.id} = ${deliveries_stops.delivery_id} where ${deliveries_stops.order_id} = ${orders.id} order by ${deliveries.id} desc limit 1))`,
        lalamove_booking: sql<{ id: number; status: string; booking_state: string; active: boolean; stop_count: number } | null>`(select json_build_object('id', b.id, 'status', b.status, 'booking_state', b.booking_state, 'active', b.active, 'stop_count', b.stop_count) from delivery_orders b where b.order_id = ${orders.id} or exists (select 1 from delivery_order_stops s where s.booking_id = b.id and s.order_id = ${orders.id}) order by b.id desc limit 1)`,
        version: orders.version,
      })
      .from(orders)
      .leftJoin(customers, eq(orders.customer_id, customers.id))
      .leftJoin(users, eq(customers.user_id, users.id))
      .where(eq(orders.id, id));

    if (!row) return null;

    const items = await db
      .select({
        quantity: order_items.quantity,
        price: order_items.unit_price_snapshot,
      })
      .from(order_items)
      .leftJoin(inventory, eq(order_items.inventory_id, inventory.id))
      .leftJoin(
        product_variants,
        eq(inventory.product_variant_id, product_variants.id),
      )
      .where(eq(order_items.order_id, id));

    return {
      ...row,
      item_count: items.length,
      total_quantity: items.reduce((total, item) => total + item.quantity, 0),
      total: calculateOrderTotal(items),
    };
  }

  static async getOrders(
    page: number = 1,
    limit: number = 10,
    search: string = "",
    delivery_type: string = "",
    sort_by: string = "id:desc",
    status = "",
    warehouseId?: number,
  ) {
    page = Number.isSafeInteger(page) && page >= 0 ? page : 0;
    limit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 10;
    const offset = page * limit;
    const [sortField, sortOrder] = sort_by.split(":");

    const statuses = ["PENDING", "PROCESSING", "SCHEDULING", "SCHEDULED", "IN_TRANSIT", "COMPLETED", "CANCELLED"] as const;
    const validStatus = statuses.find((value) => value === status);
    const latestDeliveryType = sql<string | null>`coalesce(${orders.delivery_method}, (select ${deliveries.delivery_type}::text from ${deliveries_stops} inner join ${deliveries} on ${deliveries.id} = ${deliveries_stops.delivery_id} where ${deliveries_stops.order_id} = ${orders.id} order by ${deliveries.id} desc limit 1))`;
    const whereQuery = and(
      or(
        ilike(users.name, `%${search}%`),
        ilike(orders.shipping_recipient, `%${search}%`),
        ilike(orders.order_number, `%${search}%`),
        ilike(orderGroupFields.order_group_number, `%${search}%`),
        ilike(customers.company_name, `%${search}%`),
        ilike(orders.shipping_address, `%${search}%`),
      ),
      validStatus ? eq(orders.status, validStatus) : undefined,
      warehouseId === undefined ? undefined : eq(orders.warehouse_id, warehouseId),
      delivery_type === "WALK_IN" ? eq(orders.sales_channel, "WALK_IN") : ["INTERNAL", "LALAMOVE", "PICKUP"].includes(delivery_type) ? sql`${latestDeliveryType} = ${delivery_type}` : undefined,
    );

    const [total_result] = await db
      .select({ count: count() })
      .from(orders)
      .leftJoin(customers, eq(orders.customer_id, customers.id))
      .leftJoin(users, eq(customers.user_id, users.id))
      .where(and(whereQuery));

    const order_rows = await db
      .select({
        id: orders.id,
        product_number: orders.order_number,
        ...orderGroupFields,
        sales_channel: orders.sales_channel,
        warehouse_id: orders.warehouse_id,
        warehouse_name: warehouses.name,
        delivery_type: latestDeliveryType,
        customer_id: orders.customer_id,
        customer_name: resolvedCustomerNameSql,
        email: users.email,
        customer_company: customers.company_name,
        shipping_address: orders.shipping_address,
        status: orders.status,
        version: orders.version,
      })
      .from(orders)
      .leftJoin(warehouses, eq(orders.warehouse_id, warehouses.id))
      .leftJoin(customers, eq(orders.customer_id, customers.id))
      .leftJoin(users, eq(customers.user_id, users.id))
      .where(and(whereQuery))
      .orderBy(this.SortByField(sortField as SortField, sortOrder as SortOrder), desc(orders.id))
      .limit(limit)
      .offset(offset);

    const rows = order_rows.map(async (row) => {
      const order_item = await db
        .select({
          id: order_items.id,
          product_name: products.name,
          product_variant_name: product_variants.name,
          product_variant_sku: product_variants.sku,
          unit: product_variants.unit,
          weight_kg: product_variants.weight_kg,
          width_value: product_variants.width_value,
          width_unit: product_variants.width_unit,
          length_value: product_variants.length_value,
          length_unit: product_variants.length_unit,
          quantity: order_items.quantity,
          price: order_items.unit_price_snapshot,
        })
        .from(order_items)
        .leftJoin(inventory, eq(order_items.inventory_id, inventory.id))
        .leftJoin(products, eq(inventory.product_id, products.id))
        .leftJoin(
          product_variants,
          eq(inventory.product_variant_id, product_variants.id),
        )
        .where(eq(order_items.order_id, row.id));

      return {
        ...row,
        items: order_item.map((item) => ({
          ...item,
          price: item.price === null ? null : Number(item.price),
        })),
        item_count: order_item.length,
        total_quantity: order_item.reduce(
          (acc, item) => acc + item.quantity,
          0,
        ),
        total: calculateOrderTotal(order_item),
      };
    });

    return {
      rows: await Promise.all(rows),
      total: total_result?.count ?? 0,
    };
  }

  private static GroupedSortByField(field: SortField, order: SortOrder) {
    const dir = order === "asc" ? asc : desc;
    switch (field) {
      case "product_number":
        return dir(sql`min(coalesce(${order_groups.group_number}, ${orders.order_number}))`);
      case "warehouse_name":
        return dir(sql`min(${warehouses.name})`);
      case "customer_name":
        return dir(sql`min(${resolvedCustomerNameSql})`);
      case "item_count":
        return dir(sql`sum((select count(*)::int from ${order_items} where ${order_items.order_id} = ${orders.id}))`);
      case "total":
        return dir(sql`sum((select case when bool_and(${order_items.unit_price_snapshot} is not null) then sum(${order_items.quantity} * ${order_items.unit_price_snapshot}) else null end from ${order_items} where ${order_items.order_id} = ${orders.id}))`);
      case "id":
      default:
        return dir(sql`max(${orders.id})`);
    }
  }

  static async getGroupedOrders(
    page: number = 0,
    limit: number = 10,
    search: string = "",
    delivery_type: string = "",
    sort_by: string = "id:desc",
    status = "",
    warehouseId?: number,
  ) {
    page = Number.isSafeInteger(page) && page >= 0 ? page : 0;
    limit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 10;
    const offset = page * limit;
    const [sortField, sortOrder] = sort_by.split(":");

    const statuses = ["PENDING", "PROCESSING", "SCHEDULING", "SCHEDULED", "IN_TRANSIT", "COMPLETED", "CANCELLED"] as const;
    const validStatus = statuses.find((value) => value === status);
    const latestDeliveryType = sql<string | null>`coalesce(${orders.delivery_method}, (select ${deliveries.delivery_type}::text from ${deliveries_stops} inner join ${deliveries} on ${deliveries.id} = ${deliveries_stops.delivery_id} where ${deliveries_stops.order_id} = ${orders.id} order by ${deliveries.id} desc limit 1))`;
    const entryKey = sql<string>`coalesce(${orders.order_group_id}::text, 'order-' || ${orders.id}::text)`;
    const trimmedSearch = search.trim();
    const match = `%${trimmedSearch}%`;

    const whereQuery = and(
      trimmedSearch
        ? or(
            ilike(users.name, match),
            ilike(orders.shipping_recipient, match),
            ilike(orders.order_number, match),
            ilike(order_groups.group_number, match),
            ilike(customers.company_name, match),
            ilike(orders.shipping_address, match),
          )
        : undefined,
      validStatus ? eq(orders.status, validStatus) : undefined,
      warehouseId === undefined ? undefined : eq(orders.warehouse_id, warehouseId),
      delivery_type === "WALK_IN"
        ? eq(orders.sales_channel, "WALK_IN")
        : ["INTERNAL", "LALAMOVE", "PICKUP"].includes(delivery_type)
          ? sql`${latestDeliveryType} = ${delivery_type}`
          : undefined,
    );

    const [total_result] = await db
      .select({ total: sql<number>`count(distinct ${entryKey})`.mapWith(Number) })
      .from(orders)
      .leftJoin(order_groups, eq(orders.order_group_id, order_groups.id))
      .leftJoin(warehouses, eq(orders.warehouse_id, warehouses.id))
      .leftJoin(customers, eq(orders.customer_id, customers.id))
      .leftJoin(users, eq(customers.user_id, users.id))
      .where(whereQuery);

    const entries = await db
      .select({
        id: sql<number>`min(${orders.id})`.mapWith(Number),
        group_id: orders.order_group_id,
      })
      .from(orders)
      .leftJoin(order_groups, eq(orders.order_group_id, order_groups.id))
      .leftJoin(warehouses, eq(orders.warehouse_id, warehouses.id))
      .leftJoin(customers, eq(orders.customer_id, customers.id))
      .leftJoin(users, eq(customers.user_id, users.id))
      .where(whereQuery)
      .groupBy(entryKey, orders.order_group_id)
      .orderBy(
        this.GroupedSortByField(sortField as SortField, sortOrder as SortOrder),
        desc(sql`max(${orders.id})`),
      )
      .limit(limit)
      .offset(offset);

    if (!entries.length) {
      return { rows: [], total: total_result?.total ?? 0 };
    }

    const groupIds = entries.flatMap((entry) => (entry.group_id ? [entry.group_id] : []));
    const singleIds = entries.filter((entry) => !entry.group_id).map((entry) => entry.id);

    const rawOrders = await db
      .select({
        id: orders.id,
        product_number: orders.order_number,
        ...orderGroupFields,
        sales_channel: orders.sales_channel,
        warehouse_id: orders.warehouse_id,
        warehouse_name: warehouses.name,
        delivery_type: latestDeliveryType,
        customer_id: orders.customer_id,
        customer_name: resolvedCustomerNameSql,
        email: users.email,
        customer_company: customers.company_name,
        shipping_address: orders.shipping_address,
        status: orders.status,
        version: orders.version,
      })
      .from(orders)
      .leftJoin(warehouses, eq(orders.warehouse_id, warehouses.id))
      .leftJoin(customers, eq(orders.customer_id, customers.id))
      .leftJoin(users, eq(customers.user_id, users.id))
      .where(
        and(
          or(
            groupIds.length ? inArray(orders.order_group_id, groupIds) : undefined,
            singleIds.length ? inArray(orders.id, singleIds) : undefined,
          ),
          warehouseId === undefined ? undefined : eq(orders.warehouse_id, warehouseId),
        ),
      )
      .orderBy(asc(orders.order_group_position), asc(orders.id));

    const orderIds = rawOrders.map((row) => row.id);
    const allItems = orderIds.length
      ? await db
          .select({
            order_id: order_items.order_id,
            id: order_items.id,
            product_name: products.name,
            product_variant_name: product_variants.name,
            product_variant_sku: product_variants.sku,
            unit: product_variants.unit,
            weight_kg: product_variants.weight_kg,
            width_value: product_variants.width_value,
            width_unit: product_variants.width_unit,
            length_value: product_variants.length_value,
            length_unit: product_variants.length_unit,
            quantity: order_items.quantity,
            price: order_items.unit_price_snapshot,
          })
          .from(order_items)
          .leftJoin(inventory, eq(order_items.inventory_id, inventory.id))
          .leftJoin(products, eq(inventory.product_id, products.id))
          .leftJoin(product_variants, eq(inventory.product_variant_id, product_variants.id))
          .where(inArray(order_items.order_id, orderIds))
      : [];

    const itemsByOrderId = new Map<number, typeof allItems>();
    for (const item of allItems) {
      const bucket = itemsByOrderId.get(item.order_id);
      if (bucket) bucket.push(item);
      else itemsByOrderId.set(item.order_id, [item]);
    }

    const hydratedOrders = rawOrders.map((row) => {
      const orderItems = itemsByOrderId.get(row.id) ?? [];
      return {
        ...row,
        entry_type: "SINGLE" as const,
        items: orderItems.map((item) => ({
          id: item.id,
          product_name: item.product_name,
          product_variant_name: item.product_variant_name,
          product_variant_sku: item.product_variant_sku,
          quantity: item.quantity,
          price: item.price === null ? null : Number(item.price),
        })),
        item_count: orderItems.length,
        total_quantity: orderItems.reduce((acc, item) => acc + item.quantity, 0),
        total: calculateOrderTotal(orderItems),
      };
    });

    const bySingleId = new Map(hydratedOrders.filter((o) => !o.order_group_id).map((o) => [o.id, o]));
    const byGroupId = new Map<string, typeof hydratedOrders>();
    for (const orderRow of hydratedOrders) {
      if (!orderRow.order_group_id) continue;
      const bucket = byGroupId.get(orderRow.order_group_id);
      if (bucket) bucket.push(orderRow);
      else byGroupId.set(orderRow.order_group_id, [orderRow]);
    }

    type HydratedOrder = (typeof hydratedOrders)[number];
    type GroupedEntry = Omit<
      HydratedOrder,
      "entry_type" | "order_group_position" | "items" | "warehouse_id" | "status"
    > & {
      entry_type: "GROUP";
      order_group_position: null;
      warehouse_id: number | null;
      status: string;
      warehouse_names: string[];
      destinations: string[];
      status_counts: Record<string, number>;
      active_member_count: number;
      ready_for_scheduling_count: number;
      pending_action_count: number;
      processing_action_count: number;
      members: HydratedOrder[];
    };

    const rows: (HydratedOrder | GroupedEntry)[] = [];
    for (const entry of entries) {
      if (!entry.group_id) {
        const single = bySingleId.get(entry.id);
        if (single) rows.push(single);
        continue;
      }

      const members = byGroupId.get(entry.group_id) ?? [];
      const first = members[0];
      if (!first) continue;
      const activeMembers = members.filter((m) => m.status !== "CANCELLED");
      const summaryMembers = activeMembers.length > 0 ? activeMembers : members;

      const statusCounts: Record<string, number> = {};
      for (const member of members) {
        statusCounts[member.status] = (statusCounts[member.status] ?? 0) + 1;
      }

      const summaryStatuses = [...new Set(summaryMembers.map((m) => m.status))];
      const groupStatus =
        summaryStatuses.length === 1 && summaryStatuses[0]
          ? summaryStatuses[0]
          : "MIXED";

      const warehouseNames = [...new Set(members.map((m) => m.warehouse_name).filter((w): w is string => Boolean(w)))];
      const destinations = [...new Set(members.map((m) => m.shipping_address?.trim()).filter((a): a is string => Boolean(a)))];
      const deliveryTypes = [...new Set(summaryMembers.map((m) => m.delivery_type).filter((d): d is string => Boolean(d)))];

      const hasUnverified = summaryMembers.some((m) => m.total === null);
      const groupTotal = hasUnverified
        ? null
        : Number(
            minorUnitsToMoney(
              summaryMembers.reduce(
                (sum, m) => sum + moneyToMinorUnits((m.total ?? 0).toFixed(2)),
                0n,
              ),
            ),
          );

      rows.push({
        entry_type: "GROUP" as const,
        id: first.id,
        version: first.version,
        product_number: first.order_group_number ?? first.product_number,
        order_group_id: first.order_group_id,
        order_group_number: first.order_group_number,
        order_group_position: null,
        order_group_size: members.length,
        sales_channel: first.sales_channel,
        warehouse_id: warehouseNames.length === 1 ? first.warehouse_id : null,
        warehouse_name:
          warehouseNames.length === 1
            ? (warehouseNames[0] ?? null)
            : warehouseNames.length > 1
              ? `${warehouseNames.length} warehouses`
              : null,
        warehouse_names: warehouseNames,
        delivery_type:
          deliveryTypes.length === 1 && deliveryTypes[0]
            ? deliveryTypes[0]
            : deliveryTypes.length > 1
              ? "MULTIPLE"
              : null,
        customer_id: first.customer_id,
        customer_name: first.customer_name,
        email: first.email,
        customer_company: first.customer_company,
        shipping_address:
          destinations.length === 1
            ? (destinations[0] ?? null)
            : destinations.length > 1
              ? `${destinations.length} destinations`
              : null,
        destinations,
        status: groupStatus,
        status_counts: statusCounts,
        active_member_count: activeMembers.length,
        ready_for_scheduling_count: activeMembers.filter((m) => m.status === "SCHEDULING").length,
        pending_action_count: members.filter((m) => m.status === "PENDING" && m.delivery_type !== "WALK_IN").length,
        processing_action_count: members.filter((m) => m.status === "PROCESSING" && m.delivery_type !== "WALK_IN").length,
        item_count: summaryMembers.reduce((sum, m) => sum + m.item_count, 0),
        total_quantity: summaryMembers.reduce((sum, m) => sum + m.total_quantity, 0),
        total: groupTotal,
        members,
      });
    }

    return {
      rows,
      total: total_result?.total ?? 0,
    };
  }

  static async getOrderById(orderId: number, warehouseId?: number) {
    const [order_row] = await db
      .select({
        id: orders.id,
        order_number: orders.order_number,
        ...orderGroupFields,
        sales_channel: orders.sales_channel,
        warehouse_id: orders.warehouse_id,
        warehouse_name: warehouses.name,
        payment_arrangement: orders.payment_arrangement,
        shipping_recipient: orders.shipping_recipient,
        shipping_phone: orders.shipping_phone,
        shipping_address: orders.shipping_address,
        shipping_latitude: orders.shipping_latitude,
        shipping_longitude: orders.shipping_longitude,
        customer_address_id: orders.shipping_address_source_id,
        delivery_type: sql<string | null>`coalesce(${orders.delivery_method}, (select ${deliveries.delivery_type}::text from ${deliveries_stops} inner join ${deliveries} on ${deliveries.id} = ${deliveries_stops.delivery_id} where ${deliveries_stops.order_id} = ${orders.id} order by ${deliveries.id} desc limit 1))`,
        payment_method: sql<string | null>`(select ${payments.payment_method} from ${payments} where ${payments.order_id} = ${orders.id} order by ${payments.id} limit 1)`,
        payment_type: sql<string | null>`(select ${payments.payment_type} from ${payments} where ${payments.order_id} = ${orders.id} order by ${payments.id} limit 1)`,
        amount_paid: sql<number>`coalesce((select sum(${payments.amount}) from ${payments} where ${payments.order_id} = ${orders.id}), 0)`.mapWith(Number),
        walk_in_amount_tendered: orders.walk_in_amount_tendered,
        invoice_number: sql<string | null>`(select ${invoices.invoice_number} from ${invoices} where ${invoices.order_id} = ${orders.id} limit 1)`,
        customer_id: orders.customer_id,
        customer_name: resolvedCustomerNameSql,
        customer_company: sql<string | null>`case when ${orders.sales_channel} = 'WALK_IN' and ${users.email} = ${WALK_IN_SYSTEM_EMAIL} then null else nullif(nullif(trim(${customers.company_name}), ''), 'none') end`,
        customer_email: sql<string | null>`nullif(${users.email}, ${WALK_IN_SYSTEM_EMAIL})`,
        customer_phone: sql<string | null>`nullif(nullif(trim(${customers.phone_number}), ''), 'N/A')`,
        status: orders.status,
        tracking_token: orders.tracking_token,
        notes: orders.notes,
        version: orders.version,
        created_at: orders.created_at,
        updated_at: orders.updated_at,
      })
      .from(orders)
      .leftJoin(customers, eq(orders.customer_id, customers.id))
      .leftJoin(users, eq(customers.user_id, users.id))
      .leftJoin(warehouses, eq(orders.warehouse_id, warehouses.id))
      .where(eq(orders.id, orderId));

    if (!order_row) return null;

    const [order_item, [deliveryRow], combined_payment, groupMembers] = await Promise.all([
      db
        .select({
          id: order_items.id,
          inventory_id: order_items.inventory_id,
          product_id: inventory.product_id,
          product_name: products.name,
          product_variant_name: product_variants.name,
          product_variant_sku: product_variants.sku,
          unit: product_variants.unit,
          weight_kg: product_variants.weight_kg,
          width_value: product_variants.width_value,
          width_unit: product_variants.width_unit,
          length_value: product_variants.length_value,
          length_unit: product_variants.length_unit,
          description: product_variants.description,
          quantity: order_items.quantity,
          price: order_items.unit_price_snapshot,
        })
        .from(order_items)
        .leftJoin(inventory, eq(order_items.inventory_id, inventory.id))
        .leftJoin(products, eq(inventory.product_id, products.id))
        .leftJoin(
          product_variants,
          eq(inventory.product_variant_id, product_variants.id),
        )
        .where(eq(order_items.order_id, orderId)),
      db
        .select({
          delivery_id: deliveries.id,
          delivery_status: deliveries.status,
          delivery_type: deliveries.delivery_type,
          scheduled_date: deliveries.scheduled_date,
          departure_time: deliveries.departure_time,
          stop_status: deliveries_stops.status,
          delivered_at: deliveries_stops.delivered_at,
          driver_name: users.name,
          vehicle_plate: vehicles.plate_number,
          vehicle_type: vehicles.type,
        })
        .from(deliveries_stops)
        .innerJoin(deliveries, eq(deliveries.id, deliveries_stops.delivery_id))
        .leftJoin(users, eq(users.id, deliveries.driver_id))
        .leftJoin(vehicles, eq(vehicles.id, deliveries.vehicle_id))
        .where(and(eq(deliveries_stops.order_id, orderId), sql`${deliveries.status} <> 'cancelled'`))
        .orderBy(desc(deliveries.id))
        .limit(1),
      getOrderCombinedPayment(orderId),
      order_row.order_group_id
        ? db
            .select({
              id: orders.id,
              order_number: orders.order_number,
              order_group_position: orders.order_group_position,
              status: orders.status,
              warehouse_name: warehouses.name,
              shipping_address: orders.shipping_address,
              total: sql<string | null>`(
                select case
                  when count(*) > 0 and bool_and(${order_items.unit_price_snapshot} is not null)
                  then sum(${order_items.quantity} * ${order_items.unit_price_snapshot})
                  else null
                end
                from ${order_items}
                where ${order_items.order_id} = ${orders.id}
              )`,
            })
            .from(orders)
            .leftJoin(warehouses, eq(orders.warehouse_id, warehouses.id))
            .where(
              and(
                eq(orders.order_group_id, order_row.order_group_id),
                warehouseId === undefined ? undefined : eq(orders.warehouse_id, warehouseId),
              ),
            )
            .orderBy(asc(orders.order_group_position), asc(orders.id))
        : Promise.resolve([]),
    ]);

    return {
      ...order_row,
      walk_in_amount_tendered:
        order_row.walk_in_amount_tendered === null
          ? null
          : Number(order_row.walk_in_amount_tendered),
      delivery: deliveryRow ?? null,
      combined_payment,
      group_members: groupMembers.map((member) => ({
        ...member,
        total: member.total === null ? null : Number(member.total),
      })),
      is_custom_shipping: order_row.customer_address_id === null,
      items: order_item.map((item) => ({
        ...item,
        price: item.price === null ? null : Number(item.price),
      })),
    };
  }

  static SortByField(field: SortField, order: SortOrder) {
    const columnMap = {
      id: orders.id,
      product_number: orders.order_number,
        ...orderGroupFields,
        sales_channel: orders.sales_channel,
      warehouse_name: warehouses.name,
      customer_name: resolvedCustomerNameSql,
      item_count: sql`(select count(*) from ${order_items} where ${order_items.order_id} = ${orders.id})`,
      total: sql`(select case when bool_and(${order_items.unit_price_snapshot} is not null) then sum(${order_items.quantity} * ${order_items.unit_price_snapshot}) else null end from ${order_items} where ${order_items.order_id} = ${orders.id})`,
    } as const;

    const column = Object.hasOwn(columnMap, field) ? columnMap[field] : orders.id;

    return order === "asc" ? asc(column) : desc(column);
  }

  static async getOrderDetailsByIds(orderIds: number[], warehouseId?: number) {
    const rows = await db
      .select({
        id: orders.id,
        order_number: orders.order_number,
        ...orderGroupFields,
        sales_channel: orders.sales_channel,
        customer_company: customers.company_name,
        shipping_address: orders.shipping_address,
        destination: orders.shipping_address,
        shipping_latitude: orders.shipping_latitude,
        shipping_longitude: orders.shipping_longitude,
        item_count: sql<number>`(
          select count(*) from ${order_items}
          where ${order_items.order_id} = ${orders.id}
        )`.mapWith(Number),
        total_weight_kg: sql<number>`coalesce((
          select sum(oi.quantity * coalesce(pv.weight_kg, 0))::float8
          from order_items oi
          inner join inventory inv on inv.id = oi.inventory_id
          inner join product_variants pv on pv.id = inv.product_variant_id
          where oi.order_id = ${orders.id}
        ), 0)`.mapWith(Number),
        total: sql<string | null>`(
          select case
            when count(*) > 0 and bool_and(${order_items.unit_price_snapshot} is not null)
            then sum(${order_items.quantity} * ${order_items.unit_price_snapshot})
            else null
          end
          from ${order_items}
          where ${order_items.order_id} = ${orders.id}
        )`,
      })
      .from(orders)
      .leftJoin(customers, eq(orders.customer_id, customers.id))
      .where(and(inArray(orders.id, orderIds), warehouseId === undefined ? undefined : eq(orders.warehouse_id, warehouseId)));

    return rows.map((row) => ({
      ...row,
      total: row.total === null ? null : Number(row.total),
    }));
  }

  static async createOrder(data: CreateOrderInput) {
    return stockTransaction(tx => this.createOrderInTransaction(tx, data));
  }

  static async createWalkInOrder(data: WalkInOrderInput, staffWarehouseId?: number) {
    if (staffWarehouseId !== undefined && data.warehouse_id !== staffWarehouseId) {
      throw new WorkflowError("Choose your assigned warehouse.", 403);
    }
    if (!data.items || data.items.length === 0) {
      throw new WorkflowError("Order must have at least one item");
    }
    if (data.items.some((item) => !Number.isSafeInteger(item.quantity) || item.quantity <= 0)) {
      throw new WorkflowError("Order quantities must be positive integers.");
    }
    if (data.payment_method !== "CASH" && !data.payment_type?.trim()) {
      throw new WorkflowError("Select or enter a payment type.");
    }

    const isDelivery = data.fulfillment === "DELIVERY";
    if (data.fulfillment && !["TAKEAWAY", "DELIVERY"].includes(data.fulfillment)) throw new WorkflowError("Choose a valid fulfillment option.");
    if (data.checkout_key && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.checkout_key)) throw new WorkflowError("Invalid checkout key.");
    const fingerprint = createHash("sha256").update(JSON.stringify({
      ...Object.fromEntries(Object.entries(data).sort(([a], [b]) => a.localeCompare(b))),
      items: data.items.map(item => ({ inventory_id: item.inventory_id, quantity: item.quantity })),
    })).digest("hex");

    return stockTransaction(async (tx) => {
      // Serialize retries before any order, payment, or inventory mutation.
      if (data.checkout_key) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${data.checkout_key}, 0))`);
        const [existing] = await tx.select().from(orders).where(eq(orders.walk_in_checkout_key, data.checkout_key));
        if (existing) {
          if (existing.walk_in_checkout_fingerprint !== fingerprint) throw new WorkflowError("This checkout has already been paid with different details. Review the existing order before starting another sale.", 409);
          const total = await this.computeOrderTotalMinor(tx, existing.id);
          const tendered = moneyToMinorUnits(existing.walk_in_amount_tendered!);
          return { id: existing.id, order_number: existing.order_number,
            total: Number(minorUnitsToMoney(total)), amount_tendered: Number(minorUnitsToMoney(tendered)),
            change_due: Number(minorUnitsToMoney(tendered - total)),
            message: existing.delivery_method === "INTERNAL" ? "Paid - awaiting delivery scheduling." : `Walk-in order ${existing.order_number} completed.` };
        }
      }
      const [warehouse] = await tx
        .select({ id: warehouses.id, name: warehouses.name })
        .from(warehouses)
        .where(and(eq(warehouses.id, data.warehouse_id), activeWarehouse()))
        .for("share");
      if (!warehouse) throw new WorkflowError("Choose an active warehouse.");

      let customerRow: { id: number; name: string; phone_number: string };
      if (data.customer_id !== undefined && data.customer_id > 0) {
        const [found] = await tx
          .select({
            id: customers.id,
            name: users.name,
            phone_number: customers.phone_number,
          })
          .from(customers)
          .innerJoin(users, eq(users.id, customers.user_id))
          .where(and(eq(customers.id, data.customer_id), activeUser()))
          .for("update", { of: customers });
        if (!found) throw new WorkflowError("Customer not found.");
        customerRow = found;
      } else {
        customerRow = await this.getOrCreateWalkInCustomer(tx);
      }

      const recipient = data.walk_in_name?.trim() || customerRow.name.trim() || "Walk-in Customer";
      const phone = data.walk_in_phone?.trim() || customerRow.phone_number.trim() || "N/A";
      const counterAddress = `Walk-in Counter (${warehouse.name})`;
      let destination = coordinates(data.shipping_latitude, data.shipping_longitude);
      let shippingAddress = data.shipping_address?.trim();
      if (isDelivery && data.customer_address_id) {
        if (!data.customer_id) throw new WorkflowError("Choose a registered customer for a saved address.");
        const [address] = await tx.select().from(customer_addresses).where(and(
          eq(customer_addresses.id, data.customer_address_id), eq(customer_addresses.customer_id, data.customer_id),
        )).for("share");
        if (!address) throw new WorkflowError("Choose an address belonging to this customer.");
        shippingAddress = formatShippingAddress(address);
        destination = coordinates(address.latitude, address.longitude);
      }
      if (isDelivery) {
        if (!data.shipping_recipient?.trim() || !data.shipping_phone?.trim() || !shippingAddress) throw new WorkflowError("Delivery requires the customer's name, phone number, and address.");
        if (!/^[+()\d\s.-]{7,20}$/.test(data.shipping_phone.trim()) || data.shipping_phone.replace(/\D/g, "").length < 7) throw new WorkflowError("Enter a valid delivery phone number.");
        if (!destination) throw new WorkflowError("Confirm a valid delivery latitude and longitude; (0, 0) is not a verified destination.");
      }

      const [new_order] = await tx
        .insert(orders)
        .values({
          order_number: `DRAFT-${crypto.randomUUID().slice(0, 24)}`,
          warehouse_id: data.warehouse_id,
          customer_id: customerRow.id,
          payment_arrangement: "FULLY_PAID",
          notes: data.notes?.trim() || "",
          sales_channel: "WALK_IN",
          walk_in_checkout_key: data.checkout_key ?? null,
          walk_in_checkout_fingerprint: fingerprint,
          walk_in_amount_tendered: minorUnitsToMoney(moneyToMinorUnits(data.amount_tendered)),
          delivery_method: isDelivery ? "INTERNAL" : "WALK_IN",
          status: isDelivery ? "SCHEDULING" : "COMPLETED",
          shipping_recipient: isDelivery ? data.shipping_recipient!.trim() : recipient,
          shipping_phone: isDelivery ? data.shipping_phone!.trim() : phone,
          shipping_address: isDelivery ? shippingAddress! : counterAddress,
          shipping_latitude: isDelivery ? destination!.latitude : null,
          shipping_longitude: isDelivery ? destination!.longitude : null,
          shipping_address_source_id: isDelivery ? data.customer_address_id ?? null : null,
        })
        .returning({ id: orders.id });

      if (!new_order) {
        throw new WorkflowError("Failed to create walk-in order");
      }

      const order_number = `ORD-${String(new_order.id).padStart(6, "0")}`;
      await tx
        .update(orders)
        .set({ order_number })
        .where(eq(orders.id, new_order.id));

      await this.insertOrderItemsWithPriceSnapshot(tx, new_order.id, data.items);

      await changeOrderStock(tx, new_order.id, data.warehouse_id, "reserve");
      if (!isDelivery) await changeOrderStock(tx, new_order.id, data.warehouse_id, "consume");

      const totalMinor = await this.computeOrderTotalMinor(tx, new_order.id);
      let tenderedMinor: bigint;
      try {
        tenderedMinor = moneyToMinorUnits(data.amount_tendered);
      } catch {
        throw new WorkflowError("Amount tendered must be a valid monetary amount.");
      }

      if (tenderedMinor < totalMinor) {
        throw new WorkflowError("Amount tendered must be at least the order total.");
      }
      if (data.payment_method !== "CASH" && tenderedMinor !== totalMinor) {
        throw new WorkflowError("Non-cash walk-in payments must match the exact order total.");
      }

      const changeMinor = tenderedMinor - totalMinor;
      const nowDate = new Date();

      const payment = await PaymentService.createPayment(tx, {
        payment_number: `PAY-${String(new_order.id).padStart(6, "0")}`,
        order_id: new_order.id,
        customer_id: customerRow.id,
        payment_method: data.payment_method as PaymentMethodType,
        payment_type: data.payment_method === "CASH" ? null : data.payment_type?.trim() || null,
        amount: minorUnitsToMoney(totalMinor),
        payment_status: "PAID",
        received_at: nowDate,
      });

      const invoice = await InvoiceService.createInvoice(
        tx,
        new_order.id,
        customerRow.id,
        data.payment_method,
        data.items,
      );
      if (!invoice) {
        throw new WorkflowError("Failed to create invoice");
      }

      await tx
        .update(invoices)
        .set({ status: "ISSUED", issue_date: nowDate })
        .where(eq(invoices.order_id, new_order.id));

      return {
        id: new_order.id,
        order_number,
        payment_id: payment.id,
        total: Number(minorUnitsToMoney(totalMinor)),
        amount_tendered: Number(minorUnitsToMoney(tenderedMinor)),
        change_due: Number(minorUnitsToMoney(changeMinor)),
        message: isDelivery ? "Paid - awaiting delivery scheduling." : `Walk-in order ${order_number} completed.`,
      };
    });
  }

  static async createOrders(data: OrderBatchInput) {
    if (!Number.isSafeInteger(data.customer_id) || data.customer_id < 1) throw new WorkflowError("Select a customer.");
    if (data.orders.length < 1 || data.orders.length > 25) throw new WorkflowError("Submit between 1 and 25 orders together.");
    return stockTransaction(async tx => {
      const [customer] = await tx.select({ id: customers.id }).from(customers).where(eq(customers.id, data.customer_id)).for("update");
      if (!customer) throw new WorkflowError("Customer not found.");
      let entries: Omit<CreateOrderInput, "customer_id">[];
      let allocated: bigint[] | undefined;
      if (data.payment_mode === "COMBINED") {
        if (data.payment.payment_method !== "CASH" && !data.payment.payment_type?.trim()) throw new WorkflowError("Select a payment type for the combined payment.");
        const ids = [...new Set(data.orders.flatMap(order => order.items.map(item => item.inventory_id)))];
        const prices = await tx.select({ id: inventory.id, price: product_variants.price })
          .from(inventory).innerJoin(product_variants, eq(product_variants.id, inventory.product_variant_id))
          .where(inArray(inventory.id, ids)).orderBy(asc(inventory.id)).for("update");
        const byId = new Map(prices.map(row => [row.id, row.price]));
        const totals = data.orders.map((order, index) => {
          const total = order.items.reduce((sum, item) => {
            const price = byId.get(item.inventory_id);
            if (price === undefined) throw new WorkflowError(`Order ${index + 1}: inventory item is unavailable.`);
            if (!Number.isSafeInteger(item.quantity) || item.quantity <= 0) throw new WorkflowError(`Order ${index + 1}: quantities must be positive integers.`);
            return sum + moneyToMinorUnits(price) * BigInt(item.quantity);
          }, 0n);
          if (order.expected_total !== undefined && Number(minorUnitsToMoney(total)) !== order.expected_total) {
            throw new WorkflowError(`Order ${index + 1}: prices changed. Review its items and payment allocation before submitting again.`);
          }
          return total;
        });
        let amount: bigint;
        try { amount = moneyToMinorUnits(data.payment.amount_paid); }
        catch { throw new WorkflowError("Combined payment must have no more than two decimal places."); }
        allocated = allocatePayment(amount, totals);
        entries = data.orders.map((order, index) => ({
          ...order, payment_method: data.payment.payment_method, payment_type: data.payment.payment_type,
          amount_paid: Number(minorUnitsToMoney(allocated![index])),
          payment_arrangement: allocated![index] === totals[index] ? "FULLY_PAID" : allocated![index] > 0n ? "PARTIALLY_PAID" : "NET_30",
        }));
      } else entries = data.orders;
      const receivedAt = data.payment_mode === "COMBINED" ? new Date() : undefined;
      const [submission] = await tx.insert(order_groups).values({
        group_number: `OG-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
        customer_id: data.customer_id,
      }).returning();
      const created = [];
      for (const [index, order] of entries.entries()) {
        try {
          const member = await this.createOrderInTransaction(tx, { ...order, customer_id: data.customer_id }, receivedAt);
          await tx.update(orders).set({ order_group_id: submission.id, order_group_position: index + 1 }).where(eq(orders.id, member.id));
          created.push(member);
        } catch (error) {
          if (error instanceof WorkflowError) throw new WorkflowError(`Order ${index + 1}: ${error.message}`, error.status);
          throw error;
        }
      }
      if (data.payment_mode === "COMBINED" && allocated) {
        const [group] = await tx.insert(payment_groups).values({
          payment_number: `CP-${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
          customer_id: data.customer_id, payment_method: data.payment.payment_method,
          payment_type: data.payment.payment_method === "CASH" ? null : data.payment.payment_type?.trim(),
          reference_number: data.payment.reference_number?.trim() || null,
          amount: minorUnitsToMoney(moneyToMinorUnits(data.payment.amount_paid)),
          received_at: receivedAt,
        }).returning();
        await tx.insert(payment_group_allocations).values(created.map((order, index) => ({
          group_id: group.id, payment_id: order.payment_id, amount: minorUnitsToMoney(allocated![index]),
        })));
      }
      return created;
    });
  }

  private static async createOrderInTransaction(tx: StockTransaction, data: CreateOrderInput, receivedAt?: Date) {
    if (data.items.some((item) => !Number.isSafeInteger(item.quantity) || item.quantity <= 0)) throw new WorkflowError("Order quantities must be positive integers.");
    if (data.items.length === 0) {
      throw new WorkflowError("Order must have at least one item");
    }

    const [warehouse] = await tx.select({ id: warehouses.id }).from(warehouses).where(and(eq(warehouses.id, data.warehouse_id), activeWarehouse())).for("share");
    if (!warehouse) throw new WorkflowError("Choose an active warehouse.");
    const [customer] = await tx
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.id, data.customer_id))
      .for("update");
    if (!customer) throw new WorkflowError("Customer not found.");

    let customer_recipient: string;
    let customer_phone: string;
    let customer_address: string;
    let destination = coordinates(data.shipping_latitude, data.shipping_longitude);
    let addressSourceId: number | null = null;
    if ((data.shipping_latitude !== undefined || data.shipping_longitude !== undefined) && !destination) throw new WorkflowError("Provide a valid latitude and longitude pair.");

    if (data.is_custom_shipping || !data.customer_address_id) {
      throw new WorkflowError("Select a saved shipping address for this order.");
    }
    {
      const [customerQuery] = await tx
        .select({
          name: users.name,
          phone_number: customers.phone_number,
        })
        .from(customers)
        .innerJoin(users, eq(customers.user_id, users.id))
        .where(and(eq(customers.id, data.customer_id), activeUser()));
      if (!customerQuery) throw new WorkflowError("Customer not found.");

      const savedAddresses = await tx
        .select({
          id: customer_addresses.id,
          latitude: customer_addresses.latitude,
          longitude: customer_addresses.longitude,
          address_line: customer_addresses.address_line,
          barangay: customer_addresses.barangay,
          city_municipality: customer_addresses.city_municipality,
          province: customer_addresses.province,
          postal_code: customer_addresses.postal_code,
        })
        .from(customer_addresses)
        .where(eq(customer_addresses.customer_id, data.customer_id))
        .orderBy(customer_addresses.id);
      const selectedAddress = savedAddresses.find(
        (savedAddress) => savedAddress.id === data.customer_address_id,
      );

      if (!selectedAddress) {
        throw new WorkflowError(
          savedAddresses.length === 0
            ? "Save a shipping address for this customer before creating an order."
            : "Select one of this customer's saved shipping addresses.",
        );
      }

      addressSourceId = selectedAddress.id;
      destination = coordinates(selectedAddress.latitude, selectedAddress.longitude);
      customer_recipient = customerQuery.name.trim();
      customer_phone = customerQuery.phone_number.trim();
      customer_address = formatShippingAddress(selectedAddress);
      if (!customer_recipient || !customer_phone || !customer_address) {
        throw new WorkflowError(
          "The selected saved address or customer contact details are incomplete.",
        );
      }
    }

    const [new_order] = await tx
      .insert(orders)
      .values({
        order_number: `DRAFT-${crypto.randomUUID().slice(0, 24)}`,
        warehouse_id: data.warehouse_id,
        customer_id: data.customer_id,
        payment_arrangement: data.payment_arrangement,
        notes: data.notes || "",
        shipping_recipient: customer_recipient,
        delivery_method: data.delivery_type ?? null,
        shipping_phone: customer_phone,
        shipping_address: customer_address,
        shipping_latitude: destination?.latitude ?? null,
        shipping_longitude: destination?.longitude ?? null,
        shipping_address_source_id: addressSourceId,
      })
      .returning({
        id: orders.id,
      });

    if (!new_order) {
      throw new WorkflowError("Failed to create order");
    }

    const order_number = `ORD-${String(new_order.id).padStart(6, "0")}`;

    await tx
      .update(orders)
      .set({ order_number: order_number })
      .where(eq(orders.id, new_order.id));

    await this.insertOrderItemsWithPriceSnapshot(tx, new_order.id, data.items);

    await changeOrderStock(tx, new_order.id, data.warehouse_id, "reserve");

    const totalMinor = await this.computeOrderTotalMinor(tx, new_order.id);
    const amountPaidMinor = moneyToMinorUnits(data.amount_paid);

    if (amountPaidMinor < 0n || amountPaidMinor > totalMinor) {
      throw new WorkflowError("Amount paid must be valid and cannot exceed the order total.");
    }

    if (data.payment_arrangement === "FULLY_PAID" && amountPaidMinor !== totalMinor) throw new WorkflowError("Fully paid orders must include the complete order amount.");
    if (data.payment_arrangement === "PARTIALLY_PAID" && (amountPaidMinor <= 0n || amountPaidMinor >= totalMinor)) throw new WorkflowError("Partially paid orders require an amount greater than zero and below the total.");
    const paymentStatus =
      amountPaidMinor === 0n
        ? "UNPAID"
        : amountPaidMinor >= totalMinor
          ? "PAID"
          : "PARTIALLY_PAID";

    const isFullyPaid =
      data.payment_arrangement === "FULLY_PAID" || paymentStatus === "PAID";
    const paidTimestamp = receivedAt ?? new Date();

    const payment = await PaymentService.createPayment(tx, {
      payment_number: `PAY-${String(new_order.id).padStart(6, "0")}`,
      order_id: new_order.id,
      customer_id: data.customer_id,
      payment_method: data.payment_method as PaymentMethodType,
      payment_type: data.payment_method === "CASH" ? null : data.payment_type?.trim() || null,
      amount: minorUnitsToMoney(amountPaidMinor),
      payment_status: paymentStatus,
      received_at: amountPaidMinor > 0n ? paidTimestamp : null,
    });

    const invoice = await InvoiceService.createInvoice(
      tx,
      new_order.id,
      data.customer_id,
      data.payment_method,
      data.items,
    );

    if (!invoice) {
      throw new WorkflowError("Failed to create invoice");
    }

    if (isFullyPaid) {
      await tx
        .update(orders)
        .set({ status: "SCHEDULING", updated_at: paidTimestamp })
        .where(eq(orders.id, new_order.id));

      await tx
        .update(invoices)
        .set({ status: "ISSUED", issue_date: paidTimestamp })
        .where(eq(invoices.order_id, new_order.id));
    }

    return {
      id: new_order.id,
      payment_id: payment.id,
      status: isFullyPaid ? "SCHEDULING" : "PENDING",
      message: isFullyPaid
        ? `Order ${order_number} is fully paid and routed directly to delivery scheduling.`
        : `Order ${order_number} has been created successfully.`,
    };
  }

  static async processOrder(orderId: number, version: number) {
    return await stockTransaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.version, version))).for("update");

      if (!order) {
        throw new WorkflowError("Order not found");
      }

      await assertOperationalOrder(tx, orderId);

      if (order.delivery_method === "WALK_IN") {
        throw new WorkflowError("Walk-in orders are completed at the counter and do not require processing.");
      }

      if (order.status !== "PENDING") {
        throw new WorkflowError("Order is not pending");
      }

      await tx
        .update(orders)
        .set({ status: "PROCESSING", version: order.version + 1 })
        .where(eq(orders.id, orderId));

      return {
        id: orderId,
        message: `Order ${order.order_number} is now being processed.`,
      };
    });
  }

  static async deliveryOrder(orderId: number, version: number) {
    return await stockTransaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.version, version))).for("update");

      if (!order) {
        throw new WorkflowError("Order not found");
      }

      await assertOperationalOrder(tx, orderId);

      if (order.delivery_method === "WALK_IN") {
        throw new WorkflowError("Walk-in orders are completed at the counter and cannot be scheduled for delivery.");
      }

      if (order.status !== "PROCESSING") {
        throw new WorkflowError("Order is not processing");
      }

      await tx
        .update(orders)
        .set({ status: "SCHEDULING", version: order.version + 1 })
        .where(eq(orders.id, orderId));

      await tx
        .update(invoices)
        .set({ status: "ISSUED", issue_date: new Date() })
        .where(eq(invoices.order_id, orderId));

      return {
        id: orderId,
        message: `Order ${order.order_number} is now ready for delivery.`,
      };
    });
  }

  static async processOrderGroup(groupId: string, warehouseId?: number) {
    return await stockTransaction(async (tx) => {
      const members = await tx
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.order_group_id, groupId),
            warehouseId === undefined ? undefined : eq(orders.warehouse_id, warehouseId),
          ),
        )
        .orderBy(asc(orders.id))
        .for("update");

      if (!members.length) {
        throw new WorkflowError("Order group not found.", 404);
      }

      const eligible = members.filter(
        (member) => member.status === "PENDING" && member.delivery_method !== "WALK_IN",
      );

      if (!eligible.length) {
        throw new WorkflowError("No pending orders in this group can be processed.");
      }

      for (const member of eligible) {
        await assertOperationalOrder(tx, member.id);
        await tx
          .update(orders)
          .set({ status: "PROCESSING", version: member.version + 1, updated_at: new Date() })
          .where(eq(orders.id, member.id));
      }

      return {
        group_id: groupId,
        updated_ids: eligible.map((member) => member.id),
        count: eligible.length,
        message: `${eligible.length} ${eligible.length === 1 ? "order" : "orders"} in this group ${eligible.length === 1 ? "is" : "are"} now being processed.`,
      };
    });
  }

  static async deliveryOrderGroup(groupId: string, warehouseId?: number) {
    return await stockTransaction(async (tx) => {
      const members = await tx
        .select()
        .from(orders)
        .where(
          and(
            eq(orders.order_group_id, groupId),
            warehouseId === undefined ? undefined : eq(orders.warehouse_id, warehouseId),
          ),
        )
        .orderBy(asc(orders.id))
        .for("update");

      if (!members.length) {
        throw new WorkflowError("Order group not found.", 404);
      }

      const eligible = members.filter(
        (member) => member.status === "PROCESSING" && member.delivery_method !== "WALK_IN",
      );

      if (!eligible.length) {
        throw new WorkflowError("No processing orders in this group are ready for delivery.");
      }

      const issuedAt = new Date();
      for (const member of eligible) {
        await assertOperationalOrder(tx, member.id);
        await tx
          .update(orders)
          .set({ status: "SCHEDULING", version: member.version + 1, updated_at: issuedAt })
          .where(eq(orders.id, member.id));

        await tx
          .update(invoices)
          .set({ status: "ISSUED", issue_date: issuedAt })
          .where(eq(invoices.order_id, member.id));
      }

      return {
        group_id: groupId,
        updated_ids: eligible.map((member) => member.id),
        count: eligible.length,
        message: `${eligible.length} ${eligible.length === 1 ? "order" : "orders"} in this group ${eligible.length === 1 ? "is" : "are"} now ready for delivery.`,
      };
    });
  }

  static async separateOrderFromGroup(orderId: number, version: number) {
    return await stockTransaction(async (tx) => {
      const [initial] = await tx
        .select({
          id: orders.id,
          order_group_id: orders.order_group_id,
        })
        .from(orders)
        .where(eq(orders.id, orderId));

      if (!initial) {
        throw new WorkflowError("Order not found.", 404);
      }

      if (!initial.order_group_id) {
        throw new WorkflowError("This order is not part of a grouped order.");
      }

      const groupId = initial.order_group_id;

      // Lock the group row first, then all members across every warehouse in
      // deterministic ID order to prevent races with scheduling or concurrent edits.
      const [groupRow] = await tx
        .select()
        .from(order_groups)
        .where(eq(order_groups.id, groupId))
        .for("update");

      if (!groupRow) {
        throw new WorkflowError("Order group not found. Refresh and try again.", 409);
      }

      const lockedMembers = await tx
        .select()
        .from(orders)
        .where(eq(orders.order_group_id, groupId))
        .orderBy(asc(orders.id))
        .for("update");

      const target = lockedMembers.find((member) => member.id === orderId);
      if (!target) {
        throw new WorkflowError("This order was already separated from its group. Refresh and try again.", 409);
      }

      if (target.version !== version) {
        throw new WorkflowError("Order was updated by another user. Refresh and try again.", 409);
      }

      const separableStatuses = ["PENDING", "PROCESSING", "SCHEDULING"] as const;
      if (!separableStatuses.includes(target.status as (typeof separableStatuses)[number])) {
        throw new WorkflowError(
          "Only pending, processing, or scheduling orders can be separated from a group.",
        );
      }

      const remaining = lockedMembers.filter((member) => member.id !== target.id);
      const willDissolve = remaining.length <= 1;
      const lastRemaining = remaining.length === 1 ? remaining[0] : undefined;

      const affectedIds =
        willDissolve && lastRemaining
          ? [target.id, lastRemaining.id]
          : [target.id];

      const [activeStop] = await tx
        .select({ order_id: deliveries_stops.order_id })
        .from(deliveries_stops)
        .innerJoin(deliveries, eq(deliveries.id, deliveries_stops.delivery_id))
        .where(
          and(
            inArray(deliveries_stops.order_id, affectedIds),
            inArray(deliveries.status, ["scheduled", "in_transit", "returning"]),
          ),
        )
        .limit(1);

      if (activeStop) {
        throw new WorkflowError(
          activeStop.order_id === target.id
            ? "Cannot separate an order that is assigned to an active delivery."
            : "Cannot dissolve this group while the remaining order is assigned to an active delivery.",
        );
      }

      const now = new Date();

      await tx
        .update(orders)
        .set({
          order_group_id: null,
          order_group_position: null,
          version: target.version + 1,
          updated_at: now,
        })
        .where(eq(orders.id, target.id));

      if (willDissolve) {
        const dissolvedOrder = remaining[0] ?? null;
        if (dissolvedOrder) {
          await tx
            .update(orders)
            .set({
              order_group_id: null,
              order_group_position: null,
              version: dissolvedOrder.version + 1,
              updated_at: now,
            })
            .where(eq(orders.id, dissolvedOrder.id));
        }

        await tx.delete(order_groups).where(eq(order_groups.id, groupId));

        return {
          separated_order_id: target.id,
          separated_order_number: target.order_number,
          previous_group_id: groupId,
          previous_group_number: groupRow.group_number,
          group_dissolved: true,
          remaining_count: 0,
          dissolved_order_id: dissolvedOrder?.id ?? null,
          dissolved_order_number: dissolvedOrder?.order_number ?? null,
          message: dissolvedOrder
            ? `Order ${target.order_number} was separated from group ${groupRow.group_number}. Because only 1 order remained, the group was dissolved and ${dissolvedOrder.order_number} is now an independent order.`
            : `Order ${target.order_number} was separated and group ${groupRow.group_number} was dissolved.`,
        };
      }

      const orderedRemaining = [...remaining].sort(
        (a, b) =>
          (a.order_group_position ?? Number.MAX_SAFE_INTEGER) -
            (b.order_group_position ?? Number.MAX_SAFE_INTEGER) || a.id - b.id,
      );

      // Clear positions first to avoid intermediate collisions on unique(order_group_id, order_group_position).
      await tx
        .update(orders)
        .set({ order_group_position: null })
        .where(inArray(orders.id, orderedRemaining.map((member) => member.id)));

      for (const [index, member] of orderedRemaining.entries()) {
        const nextPosition = index + 1;
        const positionChanged = member.order_group_position !== nextPosition;
        await tx
          .update(orders)
          .set({
            order_group_position: nextPosition,
            version: positionChanged ? member.version + 1 : member.version,
            updated_at: positionChanged ? now : member.updated_at,
          })
          .where(eq(orders.id, member.id));
      }

      return {
        separated_order_id: target.id,
        separated_order_number: target.order_number,
        previous_group_id: groupId,
        previous_group_number: groupRow.group_number,
        group_dissolved: false,
        remaining_count: orderedRemaining.length,
        dissolved_order_id: null,
        dissolved_order_number: null,
        message: `Order ${target.order_number} was separated from group ${groupRow.group_number}. ${orderedRemaining.length} orders remain in the group.`,
      };
    });
  }

  static async groupOrders(
    items: { id: number; version: number }[],
    targetGroupId?: string,
    warehouseId?: number,
  ) {
    const uniqueIds = new Set(items.map((item) => item.id));
    if (uniqueIds.size !== items.length) {
      throw new WorkflowError("Select distinct orders to group.");
    }

    const minCount = targetGroupId ? 1 : 2;
    if (items.length < minCount) {
      throw new WorkflowError(
        targetGroupId
          ? "Select at least 1 order to add to the group."
          : "Select at least 2 orders to create an order group.",
      );
    }

    if (items.length > 25) {
      throw new WorkflowError("An order group can contain at most 25 orders.");
    }

    const versionById = new Map(items.map((item) => [item.id, item.version]));
    const selectedIds = items.map((item) => item.id);
    const groupableStatuses = ["PENDING", "PROCESSING", "SCHEDULING"] as const;
    const lockedGroupStatuses = ["SCHEDULED", "IN_TRANSIT", "COMPLETED"] as const;

    return await stockTransaction(async (tx) => {
      let existingGroup: typeof order_groups.$inferSelect | undefined;
      if (targetGroupId) {
        const [groupRow] = await tx
          .select()
          .from(order_groups)
          .where(eq(order_groups.id, targetGroupId))
          .for("update");
        if (!groupRow) {
          throw new WorkflowError("Target order group not found.", 404);
        }
        existingGroup = groupRow;
      }

      const lockedOrders = await tx
        .select()
        .from(orders)
        .where(
          existingGroup
            ? or(
                inArray(orders.id, selectedIds),
                eq(orders.order_group_id, existingGroup.id),
              )
            : inArray(orders.id, selectedIds),
        )
        .orderBy(asc(orders.id))
        .for("update");

      const byId = new Map(lockedOrders.map((row) => [row.id, row]));
      const selectedOrders: (typeof orders.$inferSelect)[] = [];

      for (const id of selectedIds) {
        const order = byId.get(id);
        if (!order) {
          throw new WorkflowError("One or more selected orders were not found.", 404);
        }
        if (warehouseId !== undefined && order.warehouse_id !== warehouseId) {
          throw new WorkflowError("One or more selected orders do not belong to your warehouse.", 404);
        }
        const expectedVersion = versionById.get(id);
        if (order.version !== expectedVersion) {
          throw new WorkflowError(
            `Order ${order.order_number} was updated by another user. Refresh and try again.`,
            409,
          );
        }
        if (order.order_group_id) {
          throw new WorkflowError(
            `Order ${order.order_number} is already part of an order group.`,
          );
        }
        if (
          !groupableStatuses.includes(
            order.status as (typeof groupableStatuses)[number],
          )
        ) {
          throw new WorkflowError(
            "Only pending, processing, or scheduling orders can be grouped.",
          );
        }
        if (order.delivery_method === "WALK_IN") {
          throw new WorkflowError("Counter walk-in orders cannot be grouped.");
        }
        selectedOrders.push(order);
      }

      const existingMembers = existingGroup
        ? lockedOrders.filter((row) => row.order_group_id === existingGroup.id)
        : [];

      if (existingGroup) {
        if (existingMembers.length === 0) {
          throw new WorkflowError("Target order group has no orders remaining. Refresh and try again.", 409);
        }
        if (
          warehouseId !== undefined &&
          !existingMembers.some((member) => member.warehouse_id === warehouseId)
        ) {
          throw new WorkflowError("Order group not found in your warehouse.", 404);
        }
        if (existingMembers.length + selectedOrders.length > 25) {
          throw new WorkflowError("An order group can contain at most 25 orders.");
        }
        if (
          existingMembers.some((member) =>
            lockedGroupStatuses.includes(
              member.status as (typeof lockedGroupStatuses)[number],
            ),
          )
        ) {
          throw new WorkflowError(
            "Cannot add orders to a group that already has scheduled, in-transit, or completed orders.",
          );
        }
      }

      const customerId = existingGroup
        ? existingGroup.customer_id
        : selectedOrders[0]?.customer_id;
      if (customerId === undefined) {
        throw new WorkflowError("Select at least 2 orders to create an order group.");
      }

      if (selectedOrders.some((order) => order.customer_id !== customerId)) {
        throw new WorkflowError(
          "Only orders belonging to the same customer can be grouped together.",
        );
      }

      const [customerUser] = await tx
        .select({ email: users.email })
        .from(customers)
        .innerJoin(users, eq(users.id, customers.user_id))
        .where(eq(customers.id, customerId))
        .limit(1);

      if (!customerUser) {
        throw new WorkflowError("Customer not found.", 404);
      }
      if (customerUser.email === WALK_IN_SYSTEM_EMAIL) {
        throw new WorkflowError("Anonymous walk-in orders cannot be grouped.");
      }

      const affectedIds = [
        ...selectedOrders.map((order) => order.id),
        ...existingMembers.map((member) => member.id),
      ];

      const [activeStop] = await tx
        .select({ order_id: deliveries_stops.order_id })
        .from(deliveries_stops)
        .innerJoin(deliveries, eq(deliveries.id, deliveries_stops.delivery_id))
        .where(
          and(
            inArray(deliveries_stops.order_id, affectedIds),
            inArray(deliveries.status, ["scheduled", "in_transit", "returning"]),
          ),
        )
        .limit(1);

      if (activeStop) {
        throw new WorkflowError(
          "Orders assigned to an active delivery cannot be grouped.",
        );
      }

      const now = new Date();
      const orderedSelected = [...selectedOrders].sort((a, b) => a.id - b.id);

      let targetGroup = existingGroup;
      let startPosition = 1;

      if (!targetGroup) {
        const [createdGroup] = await tx
          .insert(order_groups)
          .values({
            group_number: `OG-${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`,
            customer_id: customerId,
          })
          .returning();
        if (!createdGroup) {
          throw new WorkflowError("Unable to create order group.", 500);
        }
        targetGroup = createdGroup;
      } else {
        startPosition =
          existingMembers.reduce(
            (max, member) => Math.max(max, member.order_group_position ?? 0),
            0,
          ) + 1;
      }

      for (const [index, order] of orderedSelected.entries()) {
        await tx
          .update(orders)
          .set({
            order_group_id: targetGroup.id,
            order_group_position: startPosition + index,
            version: order.version + 1,
            updated_at: now,
          })
          .where(eq(orders.id, order.id));
      }

      const totalMembers = existingMembers.length + orderedSelected.length;

      return {
        group_id: targetGroup.id,
        group_number: targetGroup.group_number,
        customer_id: customerId,
        added_order_ids: orderedSelected.map((order) => order.id),
        total_members: totalMembers,
        created: !existingGroup,
        message: existingGroup
          ? `Added ${orderedSelected.length} ${orderedSelected.length === 1 ? "order" : "orders"} to group ${targetGroup.group_number} (${totalMembers} orders total).`
          : `Grouped ${totalMembers} orders under ${targetGroup.group_number}.`,
      };
    });
  }

  static async getGroupCandidates(groupId: string, warehouseId?: number) {
    const [groupRow] = await db
      .select({
        id: order_groups.id,
        group_number: order_groups.group_number,
        customer_id: order_groups.customer_id,
        customer_name: users.name,
        customer_company: customers.company_name,
        customer_email: users.email,
      })
      .from(order_groups)
      .innerJoin(customers, eq(customers.id, order_groups.customer_id))
      .innerJoin(users, eq(users.id, customers.user_id))
      .where(eq(order_groups.id, groupId))
      .limit(1);

    if (!groupRow) {
      throw new WorkflowError("Order group not found.", 404);
    }

    const existingMembers = await db
      .select({
        id: orders.id,
        warehouse_id: orders.warehouse_id,
        status: orders.status,
      })
      .from(orders)
      .where(eq(orders.order_group_id, groupId));

    if (!existingMembers.length) {
      throw new WorkflowError("Order group not found.", 404);
    }

    if (
      warehouseId !== undefined &&
      !existingMembers.some((member) => member.warehouse_id === warehouseId)
    ) {
      throw new WorkflowError("Order group not found in your warehouse.", 404);
    }

    const lockedGroupStatuses = ["SCHEDULED", "IN_TRANSIT", "COMPLETED"];
    if (
      groupRow.customer_email === WALK_IN_SYSTEM_EMAIL ||
      existingMembers.some((member) => lockedGroupStatuses.includes(member.status))
    ) {
      return {
        group_id: groupRow.id,
        group_number: groupRow.group_number,
        customer_id: groupRow.customer_id,
        customer_name: groupRow.customer_name,
        customer_company: groupRow.customer_company,
        current_size: existingMembers.length,
        max_size: 25,
        candidates: [],
      };
    }

    const rawCandidates = await db
      .select({
        id: orders.id,
        order_number: orders.order_number,
        status: orders.status,
        version: orders.version,
        warehouse_id: orders.warehouse_id,
        warehouse_name: warehouses.name,
        shipping_address: orders.shipping_address,
        delivery_type: sql<string>`coalesce(${orders.delivery_method}, 'INTERNAL')`,
        item_count: sql<number>`(select count(*)::int from ${order_items} where ${order_items.order_id} = ${orders.id})`.mapWith(Number),
        total_quantity: sql<number>`coalesce((select sum(${order_items.quantity})::int from ${order_items} where ${order_items.order_id} = ${orders.id}), 0)`.mapWith(Number),
        total: sql<string | null>`(
          select case
            when count(*) > 0 and bool_and(${order_items.unit_price_snapshot} is not null)
            then sum(${order_items.quantity} * ${order_items.unit_price_snapshot})
            else null
          end
          from ${order_items}
          where ${order_items.order_id} = ${orders.id}
        )`,
      })
      .from(orders)
      .leftJoin(warehouses, eq(orders.warehouse_id, warehouses.id))
      .where(
        and(
          eq(orders.customer_id, groupRow.customer_id),
          sql`${orders.order_group_id} is null`,
          inArray(orders.status, ["PENDING", "PROCESSING", "SCHEDULING"]),
          sql`coalesce(${orders.delivery_method}, '') <> 'WALK_IN'`,
          warehouseId === undefined ? undefined : eq(orders.warehouse_id, warehouseId),
          sql`not exists (
            select 1 from deliveries_stops ds
            inner join deliveries d on d.id = ds.delivery_id
            where ds.order_id = ${orders.id}
              and d.status in ('scheduled', 'in_transit', 'returning')
          )`,
        ),
      )
      .orderBy(desc(orders.id))
      .limit(50);

    return {
      group_id: groupRow.id,
      group_number: groupRow.group_number,
      customer_id: groupRow.customer_id,
      customer_name: groupRow.customer_name,
      customer_company: groupRow.customer_company,
      current_size: existingMembers.length,
      max_size: 25,
      candidates: rawCandidates.map((row) => ({
        ...row,
        total: row.total === null ? null : Number(row.total),
      })),
    };
  }

  static async cancelOrder(orderId: number, version: number) {
    return await stockTransaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.version, version))).for("update");

      if (!order) {
        throw new WorkflowError("Order not found");
      }

      if (order.delivery_method === "WALK_IN") {
        throw new WorkflowError("Completed walk-in orders cannot be cancelled. Use returns or payment refunds instead.");
      }

      const unscheduledSchedulingOrder = order.status === "SCHEDULING";
      if (!["PENDING", "PROCESSING"].includes(order.status) && !unscheduledSchedulingOrder) {
        throw new WorkflowError("Only pending, processing, or unscheduled scheduling orders can be cancelled");
      }
      if (unscheduledSchedulingOrder) {
        const [assigned] = await tx.select({ id: deliveries_stops.id }).from(deliveries_stops)
          .innerJoin(deliveries, eq(deliveries.id, deliveries_stops.delivery_id))
          .where(and(eq(deliveries_stops.order_id, orderId), sql`${deliveries.status} <> 'cancelled'`)).limit(1);
        if (assigned) throw new WorkflowError("Cancel the delivery assignment before cancelling this order.");
      }

      await assertNoExternalClaim(tx, orderId);
      if (order.stock_reserved) await changeOrderStock(tx, orderId, order.warehouse_id, "release");

      await tx
        .update(orders)
        .set({ status: "CANCELLED", version: order.version + 1 })
        .where(and(eq(orders.id, orderId), eq(orders.version, version)));

      return {
        id: orderId,
        message: `Order ${order.order_number} has been cancelled.`,
      };
    });
  }

  static async updateNotes(orderId: number, version: number, notes: string) {
    return this.updateOrder(orderId, { version, notes });
  }

  static async updateOrder(orderId: number, data: OrderEditInput) {
    return stockTransaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(eq(orders.id, orderId))
        .for("update");

      if (
        !order ||
        order.version !== data.version ||
        !["PENDING", "PROCESSING"].includes(order.status)
      ) {
        throw new WorkflowError(
          "Only current pending or processing orders can be edited. Refresh and try again.",
        );
      }

      const hasStructuralChange =
        data.items !== undefined ||
        data.customer_address_id !== undefined ||
        data.delivery_type !== undefined ||
        data.payment_arrangement !== undefined;

      if (order.delivery_method === "WALK_IN" && hasStructuralChange) {
        throw new WorkflowError(
          "Walk-in counter orders can only update notes.",
        );
      }

      if (
        data.items !== undefined ||
        data.customer_address_id !== undefined ||
        data.delivery_type !== undefined
      ) {
        await assertNoExternalClaim(tx, orderId);
      }

      const updates: Partial<typeof orders.$inferInsert> = {
        version: order.version + 1,
        updated_at: new Date(),
      };

      if (data.notes !== undefined) {
        updates.notes = data.notes;
      }

      if (data.delivery_type !== undefined) {
        updates.delivery_method = data.delivery_type;
      }

      if (
        data.customer_address_id !== undefined &&
        data.customer_address_id !== order.shipping_address_source_id
      ) {
        const [selectedAddress] = await tx
          .select({
            id: customer_addresses.id,
            latitude: customer_addresses.latitude,
            longitude: customer_addresses.longitude,
            address_line: customer_addresses.address_line,
            barangay: customer_addresses.barangay,
            city_municipality: customer_addresses.city_municipality,
            province: customer_addresses.province,
            postal_code: customer_addresses.postal_code,
          })
          .from(customer_addresses)
          .where(
            and(
              eq(customer_addresses.id, data.customer_address_id),
              eq(customer_addresses.customer_id, order.customer_id),
            ),
          );

        if (!selectedAddress) {
          throw new WorkflowError(
            "Select one of this customer's saved shipping addresses.",
          );
        }

        const formattedAddress = formatShippingAddress(selectedAddress);
        if (!formattedAddress) {
          throw new WorkflowError("The selected saved address is incomplete.");
        }

        const [customerContact] = await tx
          .select({
            name: users.name,
            phone_number: customers.phone_number,
          })
          .from(customers)
          .innerJoin(users, eq(customers.user_id, users.id))
          .where(eq(customers.id, order.customer_id));

        const destination = coordinates(
          selectedAddress.latitude,
          selectedAddress.longitude,
        );
        updates.shipping_address_source_id = selectedAddress.id;
        updates.shipping_address = formattedAddress;
        updates.shipping_latitude = destination?.latitude ?? null;
        updates.shipping_longitude = destination?.longitude ?? null;
        if (!order.shipping_recipient?.trim() && customerContact?.name?.trim()) {
          updates.shipping_recipient = customerContact.name.trim();
        }
        if (
          !order.shipping_phone?.trim() &&
          customerContact?.phone_number?.trim()
        ) {
          updates.shipping_phone = customerContact.phone_number.trim();
        }
      }

      let itemsChanged = false;
      if (data.items !== undefined) {
        if (
          data.items.length === 0 ||
          data.items.some(
            (item) => !Number.isSafeInteger(item.quantity) || item.quantity <= 0,
          )
        ) {
          throw new WorkflowError(
            "Order must have at least one item with a positive whole-number quantity.",
          );
        }

        const mergedItems = new Map<number, number>();
        for (const item of data.items) {
          mergedItems.set(
            item.inventory_id,
            (mergedItems.get(item.inventory_id) ?? 0) + item.quantity,
          );
        }

        const existingItems = await tx
          .select({
            id: order_items.id,
            inventory_id: order_items.inventory_id,
            quantity: order_items.quantity,
            unit_price_snapshot: order_items.unit_price_snapshot,
            price_source: order_items.price_source,
          })
          .from(order_items)
          .where(eq(order_items.order_id, orderId));

        const existingByInventory = new Map(
          existingItems.map((item) => [item.inventory_id, item]),
        );

        itemsChanged =
          existingItems.length !== mergedItems.size ||
          [...mergedItems.entries()].some(
            ([inventoryId, qty]) =>
              existingByInventory.get(inventoryId)?.quantity !== qty,
          );

        if (itemsChanged) {
          if (order.stock_reserved) {
            await changeOrderStock(tx, orderId, order.warehouse_id, "release");
          }

          await tx
            .delete(order_items)
            .where(eq(order_items.order_id, orderId));

          const idsNeedingPrice = [...mergedItems.keys()].filter((inventoryId) => {
            const snapshot = existingByInventory.get(inventoryId)?.unit_price_snapshot;
            return snapshot === null || snapshot === undefined;
          });

          const priceByInventory = new Map<number, string>();
          if (idsNeedingPrice.length > 0) {
            const currentPrices = await tx
              .select({
                inventory_id: inventory.id,
                price: product_variants.price,
              })
              .from(inventory)
              .innerJoin(
                product_variants,
                eq(inventory.product_variant_id, product_variants.id),
              )
              .where(
                and(
                  activeInventory(),
                  eq(inventory.warehouse_id, order.warehouse_id),
                  inArray(inventory.id, idsNeedingPrice),
                ),
              )
              .orderBy(asc(inventory.id))
              .for("update");

            for (const row of currentPrices) {
              priceByInventory.set(row.inventory_id, row.price);
            }
          }

          for (const [inventoryId, quantity] of mergedItems.entries()) {
            const existing = existingByInventory.get(inventoryId);
            let unitPriceSnapshot: string;
            let priceSource = "checkout";

            if (
              existing?.unit_price_snapshot !== null &&
              existing?.unit_price_snapshot !== undefined
            ) {
              unitPriceSnapshot = existing.unit_price_snapshot;
              priceSource = existing.price_source ?? "checkout";
            } else {
              const livePrice = priceByInventory.get(inventoryId);
              if (livePrice === undefined) {
                throw new WorkflowError(
                  `Inventory item ${inventoryId} is unavailable in this order's warehouse.`,
                );
              }
              unitPriceSnapshot = minorUnitsToMoney(
                moneyToMinorUnits(livePrice),
              );
            }

            await tx.insert(order_items).values({
              order_id: orderId,
              inventory_id: inventoryId,
              quantity,
              unit_price_snapshot: unitPriceSnapshot,
              price_source: priceSource,
            });
          }

          await changeOrderStock(tx, orderId, order.warehouse_id, "reserve");
        }
      }

      if (itemsChanged || data.payment_arrangement !== undefined) {
        const totalMinor = await this.computeOrderTotalMinor(tx, orderId);
        const [paidRow] = await tx
          .select({
            amount: sql<string>`coalesce(sum(${payments.amount}), 0)`,
          })
          .from(payments)
          .where(eq(payments.order_id, orderId));
        const amountPaidMinor = moneyToMinorUnits(paidRow?.amount ?? "0");

        if (amountPaidMinor > totalMinor) {
          throw new WorkflowError(
            `Order total (₱${minorUnitsToMoney(totalMinor)}) cannot be lower than the recorded payment of ₱${minorUnitsToMoney(amountPaidMinor)}. Record a refund first or keep the order total at or above the paid amount.`,
          );
        }

        if (data.payment_arrangement !== undefined) {
          if (
            data.payment_arrangement === "FULLY_PAID" &&
            amountPaidMinor !== totalMinor
          ) {
            throw new WorkflowError(
              "Fully paid arrangement requires recorded payments to match the order total.",
            );
          }
          if (
            data.payment_arrangement === "PARTIALLY_PAID" &&
            (amountPaidMinor <= 0n || amountPaidMinor >= totalMinor)
          ) {
            throw new WorkflowError(
              "Partially paid arrangement requires a recorded payment greater than zero and below the order total.",
            );
          }
          updates.payment_arrangement = data.payment_arrangement;
        } else if (itemsChanged) {
          if (
            order.payment_arrangement === "FULLY_PAID" &&
            amountPaidMinor < totalMinor
          ) {
            updates.payment_arrangement =
              amountPaidMinor > 0n ? "PARTIALLY_PAID" : "NET_30";
          } else if (
            order.payment_arrangement === "PARTIALLY_PAID" &&
            amountPaidMinor >= totalMinor &&
            totalMinor > 0n
          ) {
            updates.payment_arrangement = "FULLY_PAID";
          }
        }

        if (itemsChanged) {
          const nextPaymentStatus =
            amountPaidMinor === 0n
              ? "UNPAID"
              : amountPaidMinor >= totalMinor
                ? "PAID"
                : "PARTIALLY_PAID";
          await tx
            .update(payments)
            .set({
              payment_status: nextPaymentStatus,
              updated_at: new Date(),
            })
            .where(eq(payments.order_id, orderId));
        }

        const becameFullyPaid =
          totalMinor > 0n &&
          amountPaidMinor >= totalMinor &&
          (updates.payment_arrangement === "FULLY_PAID" ||
            order.payment_arrangement === "FULLY_PAID" ||
            itemsChanged);
        if (
          becameFullyPaid &&
          ["PENDING", "PROCESSING"].includes(order.status) &&
          order.delivery_method !== "WALK_IN"
        ) {
          updates.payment_arrangement = "FULLY_PAID";
          updates.status = "SCHEDULING";
          await tx
            .update(invoices)
            .set({ status: "ISSUED", issue_date: new Date() })
            .where(and(eq(invoices.order_id, orderId), eq(invoices.status, "DRAFT")));
        }
      }

      await tx.update(orders).set(updates).where(eq(orders.id, orderId));

      return { message: "Order updated.", id: orderId };
    });
  }

  static async setDestination(orderId: number, version: number, latitude: number, longitude: number) {
    const point = coordinates(latitude, longitude);
    if (!point) throw new WorkflowError("Provide valid destination coordinates; (0, 0) is not a verified destination.");
    return db.transaction(async (tx) => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
      if (!order || order.version !== version) throw new WorkflowError("Order changed. Refresh and try again.");
      if (order.delivery_method === "WALK_IN") throw new WorkflowError("Walk-in orders do not have a shipping destination.");
      if (!["PENDING", "PROCESSING", "SCHEDULING"].includes(order.status)) throw new WorkflowError("Destination can only be confirmed before scheduling.");
      await assertNoExternalClaim(tx, orderId);
      await tx.update(orders).set({ shipping_latitude: point.latitude, shipping_longitude: point.longitude, version: order.version + 1, updated_at: new Date() }).where(eq(orders.id, orderId));
      return { message: "Destination coordinates saved.", id: orderId };
    });
  }

  static async getReadyOrderGroup(groupId: string, warehouseId: number) {
    const members = await db.select({ id: orders.id, warehouse_id: orders.warehouse_id, status: orders.status, delivery_method: orders.delivery_method, ...orderGroupFields,
        sales_channel: orders.sales_channel,
      order_number: orders.order_number, shipping_address: orders.shipping_address,
      shipping_latitude: orders.shipping_latitude, shipping_longitude: orders.shipping_longitude,
    }).from(orders).where(and(eq(orders.order_group_id, groupId), sql`${orders.status} <> 'CANCELLED'`)).orderBy(asc(orders.order_group_position));
    if (!members.some(row => row.warehouse_id === warehouseId)) throw new WorkflowError("Order group not found in this warehouse.", 404);
    if (members.some(row => row.warehouse_id !== warehouseId)) throw new WorkflowError("All orders in this group must belong to the selected warehouse.");
    if (members.some(row => row.status !== "SCHEDULING")) throw new WorkflowError("All orders in this group must have Scheduling status before the group can be scheduled.");
    if (members.some(row => row.delivery_method === "LALAMOVE")) throw new WorkflowError("This group includes Lalamove orders. Book each external order separately.");
    if (members.some(row => row.delivery_method === "WALK_IN")) throw new WorkflowError("Walk-in orders cannot be scheduled for delivery.");
    for (const member of members) await assertNoExternalClaim(db, member.id);
    return { rows: members, total_members: members.length, group_number: members[0]!.order_group_number };
  }

  static async getSchedulingEntries(page = 0, limit = 10, search = "", warehouseId?: number) {
    page = Number.isSafeInteger(page) && page >= 0 ? page : 0;
    limit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 10;
    const key = sql<string>`coalesce(${orders.order_group_id}::text, 'order-' || ${orders.id}::text)`;
    const match = `%${search.trim()}%`;
    const predicate = and(eq(orders.status, "SCHEDULING"), internalSchedulingEligible,
      warehouseId === undefined ? undefined : eq(orders.warehouse_id, warehouseId),
      search.trim() ? or(ilike(resolvedCustomerNameSql, match), ilike(customers.company_name, match),
        ilike(orders.order_number, match), ilike(orders.shipping_address, match), ilike(orderGroupFields.order_group_number, match),
        sql`exists (select 1 from orders member where member.order_group_id = ${orders.order_group_id}
          and (member.order_number ilike ${match} or member.shipping_address ilike ${match})
          ${warehouseId === undefined ? sql`` : sql`and member.warehouse_id = ${warehouseId}`})`) : undefined);
    const [countRow] = await db.select({ total: sql<number>`count(distinct ${key})`.mapWith(Number) })
      .from(orders).leftJoin(customers, eq(customers.id, orders.customer_id)).leftJoin(users, eq(users.id, customers.user_id)).where(predicate);
    const entries = await db.select({ id: sql<number>`min(${orders.id})`.mapWith(Number), group_id: orders.order_group_id })
      .from(orders).leftJoin(customers, eq(customers.id, orders.customer_id)).leftJoin(users, eq(users.id, customers.user_id))
      .where(predicate).groupBy(key, orders.order_group_id).orderBy(desc(sql`max(${orders.id})`)).offset(page * limit).limit(limit);
    if (!entries.length) return { rows: [], total: countRow?.total ?? 0 };
    const groupIds = entries.flatMap(entry => entry.group_id ? [entry.group_id] : []);
    const singleIds = entries.filter(entry => !entry.group_id).map(entry => entry.id);
    const members = await db.select({ id: orders.id, warehouse_id: orders.warehouse_id, order_number: orders.order_number,
      active_group_size: sql<number>`(select count(*)::int from orders m where m.order_group_id = ${orders.order_group_id} and m.status <> 'CANCELLED')`.mapWith(Number),
      ...orderGroupFields,
        sales_channel: orders.sales_channel, customer_name: resolvedCustomerNameSql, customer_company: customers.company_name,
      payment_arrangement: orders.payment_arrangement, status: orders.status, shipping_address: orders.shipping_address,
      shipping_latitude: orders.shipping_latitude, shipping_longitude: orders.shipping_longitude, version: orders.version,
    }).from(orders).leftJoin(customers, eq(customers.id, orders.customer_id)).leftJoin(users, eq(users.id, customers.user_id))
      .where(and(or(groupIds.length ? inArray(orders.order_group_id, groupIds) : undefined,
        singleIds.length ? inArray(orders.id, singleIds) : undefined), sql`${orders.status} <> 'CANCELLED'`,
        warehouseId === undefined ? undefined : eq(orders.warehouse_id, warehouseId)))
      .orderBy(asc(orders.order_group_position), asc(orders.id));
    const rows = entries.map(entry => {
      const children = members.filter(member => entry.group_id ? member.order_group_id === entry.group_id : member.id === entry.id);
      const first = children[0]!;
      const total = entry.group_id ? first.active_group_size : 1;
      const ready = children.filter(member => member.status === "SCHEDULING").length;
      const oneWarehouse = children.length === total && new Set(children.map(member => member.warehouse_id)).size === 1;
      const located = children.every(member => coordinates(member.shipping_latitude, member.shipping_longitude));
      const blocked = !oneWarehouse ? "All group orders must belong to one warehouse."
        : ready !== total ? "Waiting for every order in the group to reach Scheduling."
        : !located ? "Confirm destination coordinates for every order before scheduling." : null;
      return { ...first, members: children, total_members: total, ready_count: ready,
        can_schedule: blocked === null, blocked_reason: blocked };
    });
    return { rows, total: countRow?.total ?? 0 };
  }

  static async getAllReadyForDeliveryOrders(
    page: number = 1,
    limit: number = 10,
    search: string = "",
    warehouseId?: number,
  ) {
    const offset = Math.max(page * limit, 0);

    const whereQuery = or(ilike(resolvedCustomerNameSql, `%${search}%`), ilike(orders.order_number, `%${search}%`), ilike(orderGroupFields.order_group_number, `%${search}%`));

    const [total_result] = await db
      .select({ count: count() })
      .from(orders)
      .leftJoin(customers, eq(orders.customer_id, customers.id))
      .leftJoin(users, eq(customers.user_id, users.id))
      .where(and(whereQuery, eq(orders.status, "SCHEDULING"), internalSchedulingEligible, warehouseId === undefined ? undefined : eq(orders.warehouse_id, warehouseId)));

    const rows = await db
      .select({
        id: orders.id,
        warehouse_id: orders.warehouse_id,
        order_number: orders.order_number,
        ...orderGroupFields,
        sales_channel: orders.sales_channel,
        customer_name: resolvedCustomerNameSql,
        customer_company: customers.company_name,
        payment_arrangement: orders.payment_arrangement,
        status: orders.status,
        customer_address: orders.shipping_address,
        customer_phone: sql<string>`case when ${orders.sales_channel} = 'WALK_IN' then ${orders.shipping_phone} else ${customers.phone_number} end`,
        shipping_recipient: orders.shipping_recipient,
        shipping_phone: orders.shipping_phone,
        shipping_address: orders.shipping_address,
        shipping_latitude: orders.shipping_latitude,
        shipping_longitude: orders.shipping_longitude,
        version: orders.version,
      })
      .from(orders)
      .leftJoin(customers, eq(orders.customer_id, customers.id))
      .leftJoin(users, eq(customers.user_id, users.id))
      .where(and(whereQuery, eq(orders.status, "SCHEDULING"), internalSchedulingEligible, warehouseId === undefined ? undefined : eq(orders.warehouse_id, warehouseId)))
      .orderBy(desc(orders.id))
      .offset(offset)
      .limit(limit);

    return {
      rows,
      total: total_result?.count ?? 0,
    };
  }

  static async getAllOrderForCombobox(
    page = 0, limit = 10, search = "", warehouse_id = -1,
  ) {
    const predicate = and(
      eq(orders.status, "SCHEDULING"),
      internalSchedulingEligible,
      warehouse_id > 0 ? eq(orders.warehouse_id, warehouse_id) : undefined,
      search.trim() ? or(ilike(resolvedCustomerNameSql, `%${search.trim()}%`), ilike(orders.order_number, `%${search.trim()}%`), ilike(orderGroupFields.order_group_number, `%${search.trim()}%`)) : undefined,
    );
    const [total] = await db.select({ count: count() }).from(orders)
      .leftJoin(customers, eq(orders.customer_id, customers.id))
      .leftJoin(users, eq(customers.user_id, users.id)).where(predicate);
    const rows = await db.select({
      id: orders.id, order_number: orders.order_number,
        ...orderGroupFields,
        sales_channel: orders.sales_channel,
      customer_name: resolvedCustomerNameSql, customer_company: customers.company_name,
      payment_arrangement: orders.payment_arrangement, status: orders.status,
      customer_address: orders.shipping_address, customer_phone: sql<string>`case when ${orders.sales_channel} = 'WALK_IN' then ${orders.shipping_phone} else ${customers.phone_number} end`,
      shipping_recipient: orders.shipping_recipient, shipping_phone: orders.shipping_phone,
      shipping_address: orders.shipping_address, shipping_latitude: orders.shipping_latitude,
      shipping_longitude: orders.shipping_longitude, version: orders.version,
      latitude: orders.shipping_latitude, longitude: orders.shipping_longitude,
      total_weight_kg: sql<number>`coalesce((select sum(oi.quantity * coalesce(pv.weight_kg, 0))::float8 from order_items oi inner join inventory inv on inv.id = oi.inventory_id inner join product_variants pv on pv.id = inv.product_variant_id where oi.order_id = ${orders.id}), 0)`.mapWith(Number),
    }).from(orders).leftJoin(customers, eq(orders.customer_id, customers.id))
      .leftJoin(users, eq(customers.user_id, users.id)).where(predicate)
      .orderBy(desc(orders.id)).offset(Math.max(page, 0) * limit).limit(limit);
    return { rows, total: total?.count ?? 0 };
  }

  static async getTotalOrders(warehouseId?: number) {
    const [total] = await db
      .select({ count: count() })
      .from(orders)
      .where(warehouseId === undefined ? undefined : eq(orders.warehouse_id, warehouseId));
    return total?.count ?? 0;
  }

  static async getPublicTracking(token: string) {
    const [order] = await db
      .select({
        id: orders.id,
        order_number: orders.order_number,
        status: orders.status,
        delivery_method: orders.delivery_method,
        sales_channel: orders.sales_channel,
        warehouse_name: warehouses.name,
        created_at: orders.created_at,
        updated_at: orders.updated_at,
      })
      .from(orders)
      .innerJoin(warehouses, eq(warehouses.id, orders.warehouse_id))
      .where(eq(orders.tracking_token, token));
    if (!order) throw new WorkflowError("Order tracking record not found.", 404);

    const [items, latestStop] = await Promise.all([
      db
        .select({
          product_name: products.name,
          variant_name: product_variants.name,
          quantity: order_items.quantity,
          unit: product_variants.unit,
        })
        .from(order_items)
        .innerJoin(inventory, eq(inventory.id, order_items.inventory_id))
        .innerJoin(products, eq(products.id, inventory.product_id))
        .innerJoin(
          product_variants,
          eq(product_variants.id, inventory.product_variant_id),
        )
        .where(eq(order_items.order_id, order.id))
        .orderBy(asc(order_items.id)),
      db
        .select({
          delivery_status: deliveries.status,
          scheduled_date: deliveries.scheduled_date,
          departure_time: deliveries.departure_time,
          stop_status: deliveries_stops.status,
          delivered_at: deliveries_stops.delivered_at,
        })
        .from(deliveries_stops)
        .innerJoin(deliveries, eq(deliveries.id, deliveries_stops.delivery_id))
        .where(eq(deliveries_stops.order_id, order.id))
        .orderBy(desc(deliveries_stops.id))
        .limit(1),
    ]);

    return {
      order_number: order.order_number,
      status: order.status,
      delivery_method: order.delivery_method,
      warehouse_name: order.warehouse_name,
      created_at: order.created_at,
      updated_at: order.updated_at,
      delivery: latestStop[0] ?? null,
      items,
    };
  }

  static async getCustomerRecentOrders(
    customerId: number,
    warehouseId?: number,
    limit = 5,
  ) {
    const where = and(
      eq(orders.customer_id, customerId),
      sql`${orders.status} <> 'CANCELLED'`,
      warehouseId === undefined ? undefined : eq(orders.warehouse_id, warehouseId),
    );

    const [[countRow], recentOrders] = await Promise.all([
      db.select({ total: count() }).from(orders).where(where),
      db
        .select({
          id: orders.id,
          order_number: orders.order_number,
          warehouse_id: orders.warehouse_id,
          warehouse_name: warehouses.name,
          status: orders.status,
          delivery_method: orders.delivery_method,
          payment_arrangement: orders.payment_arrangement,
          shipping_address: orders.shipping_address,
          created_at: orders.created_at,
        })
        .from(orders)
        .leftJoin(warehouses, eq(warehouses.id, orders.warehouse_id))
        .where(where)
        .orderBy(desc(orders.created_at), desc(orders.id))
        .limit(limit),
    ]);

    const orderIds = recentOrders.map((o) => o.id);
    const items = orderIds.length
      ? await db
          .select({
            order_id: order_items.order_id,
            inventory_id: order_items.inventory_id,
            quantity: order_items.quantity,
            price: order_items.unit_price_snapshot,
            product_name: products.name,
            variant_name: product_variants.name,
            sku: product_variants.sku,
            unit: product_variants.unit,
          })
          .from(order_items)
          .leftJoin(inventory, eq(inventory.id, order_items.inventory_id))
          .leftJoin(products, eq(products.id, inventory.product_id))
          .leftJoin(
            product_variants,
            eq(product_variants.id, inventory.product_variant_id),
          )
          .where(inArray(order_items.order_id, orderIds))
      : [];

    const byOrder = new Map<number, typeof items>();
    for (const item of items) {
      const list = byOrder.get(item.order_id) ?? [];
      list.push(item);
      byOrder.set(item.order_id, list);
    }

    const totalOrders = Number(countRow?.total ?? 0);
    return {
      customer_id: customerId,
      total_orders: totalOrders,
      is_suki: totalOrders >= 1,
      recent_orders: recentOrders.map((order) => {
        const orderItems = byOrder.get(order.id) ?? [];
        const total = orderItems.reduce(
          (sum, row) => sum + Number(row.price ?? 0) * row.quantity,
          0,
        );
        return {
          ...order,
          item_count: orderItems.length,
          total_quantity: orderItems.reduce((sum, row) => sum + row.quantity, 0),
          total,
          items_preview: orderItems.slice(0, 3).map((row) => ({
            product_name: row.product_name,
            variant_name: row.variant_name,
            sku: row.sku,
            unit: row.unit,
            quantity: row.quantity,
          })),
        };
      }),
    };
  }

  static async getReorderTemplate(orderId: number, warehouseId?: number) {
    const [orderRow] = await db
      .select({
        id: orders.id,
        order_number: orders.order_number,
        warehouse_id: orders.warehouse_id,
        warehouse_name: warehouses.name,
        customer_id: orders.customer_id,
        customer_name: users.name,
        customer_company: customers.company_name,
        customer_phone: customers.phone_number,
        delivery_method: orders.delivery_method,
        payment_arrangement: orders.payment_arrangement,
        notes: orders.notes,
        shipping_recipient: orders.shipping_recipient,
        shipping_phone: orders.shipping_phone,
        shipping_address: orders.shipping_address,
        shipping_latitude: orders.shipping_latitude,
        shipping_longitude: orders.shipping_longitude,
        shipping_address_source_id: orders.shipping_address_source_id,
      })
      .from(orders)
      .innerJoin(warehouses, eq(warehouses.id, orders.warehouse_id))
      .innerJoin(customers, eq(customers.id, orders.customer_id))
      .innerJoin(users, eq(users.id, customers.user_id))
      .where(
        and(
          eq(orders.id, orderId),
          warehouseId === undefined ? undefined : eq(orders.warehouse_id, warehouseId),
        ),
      );

    if (!orderRow) {
      throw new WorkflowError("Order not found.", 404);
    }

    const [savedAddresses, pastPayment, pastItems] = await Promise.all([
      db
        .select({
          id: customer_addresses.id,
          customer_id: customer_addresses.customer_id,
          address_line: customer_addresses.address_line,
          barangay: customer_addresses.barangay,
          city_municipality: customer_addresses.city_municipality,
          province: customer_addresses.province,
          postal_code: customer_addresses.postal_code,
          latitude: customer_addresses.latitude,
          longitude: customer_addresses.longitude,
        })
        .from(customer_addresses)
        .where(eq(customer_addresses.customer_id, orderRow.customer_id))
        .orderBy(asc(customer_addresses.id)),
      db
        .select({
          payment_method: payments.payment_method,
          payment_type: payments.payment_type,
        })
        .from(payments)
        .where(eq(payments.order_id, orderRow.id))
        .limit(1),
      db
        .select({
          inventory_id: order_items.inventory_id,
          requested_quantity: order_items.quantity,
          previous_price: order_items.unit_price_snapshot,
          current_price: product_variants.price,
          product_name: products.name,
          product_variant_name: product_variants.name,
          product_variant_sku: product_variants.sku,
          description: product_variants.description,
          unit: product_variants.unit,
          weight_kg: product_variants.weight_kg,
          width_value: product_variants.width_value,
          width_unit: product_variants.width_unit,
          length_value: product_variants.length_value,
          length_unit: product_variants.length_unit,
          quantity_on_hand: inventory.quantity,
          reserved: inventory.reserved,
          inventory_active: inventory.is_active,
          inventory_archived: inventory.is_archived,
          product_active: products.is_active,
          product_archived: products.is_archived,
        })
        .from(order_items)
        .leftJoin(inventory, eq(inventory.id, order_items.inventory_id))
        .leftJoin(products, eq(products.id, inventory.product_id))
        .leftJoin(
          product_variants,
          eq(product_variants.id, inventory.product_variant_id),
        )
        .where(eq(order_items.order_id, orderRow.id))
        .orderBy(asc(order_items.id)),
    ]);

    const warnings: string[] = [];
    const items: {
      inventory_id: number;
      quantity: number;
      available_stock: number;
      price: number;
      previous_price: number | null;
      product_name: string | null;
      product_variant_name: string | null;
      product_variant_sku: string | null;
      description: string | null;
      unit: string | null;
      weight_kg: string | null;
      width_value: string | null;
      width_unit: string | null;
      length_value: string | null;
      length_unit: string | null;
    }[] = [];

    for (const row of pastItems) {
      const label = [row.product_name, row.product_variant_name, row.product_variant_sku]
        .filter(Boolean)
        .join(" ");
      const operational =
        row.inventory_active === true &&
        row.inventory_archived === false &&
        row.product_active === true &&
        row.product_archived === false;
      const availableStock = Math.max(
        0,
        Number(row.quantity_on_hand ?? 0) - Number(row.reserved ?? 0),
      );
      if (!operational || availableStock <= 0) {
        warnings.push(
          `${label || `Item #${row.inventory_id}`} is currently unavailable or out of stock and was skipped.`,
        );
        continue;
      }
      const nextQty = Math.min(row.requested_quantity, availableStock);
      if (nextQty < row.requested_quantity) {
        warnings.push(
          `${label || `Item #${row.inventory_id}`} quantity reduced from ${row.requested_quantity} to ${nextQty} (available stock).`,
        );
      }
      const livePrice = Number(row.current_price ?? row.previous_price ?? 0);
      const prevPrice =
        row.previous_price !== null ? Number(row.previous_price) : null;
      if (prevPrice !== null && Math.abs(livePrice - prevPrice) >= 0.01) {
        warnings.push(
          `${label || `Item #${row.inventory_id}`} price updated from ₱${prevPrice.toFixed(2)} to ₱${livePrice.toFixed(2)}.`,
        );
      }
      items.push({
        inventory_id: row.inventory_id,
        quantity: nextQty,
        available_stock: availableStock,
        price: livePrice,
        previous_price: prevPrice,
        product_name: row.product_name,
        product_variant_name: row.product_variant_name,
        product_variant_sku: row.product_variant_sku,
        description: row.description,
        unit: row.unit,
        weight_kg: row.weight_kg,
        width_value: row.width_value,
        width_unit: row.width_unit,
        length_value: row.length_value,
        length_unit: row.length_unit,
      });
    }

    const matchedAddress =
      savedAddresses.find((a) => a.id === orderRow.shipping_address_source_id) ??
      savedAddresses[0] ??
      null;

    const paymentMethod =
      pastPayment[0]?.payment_method === "BANK_TRANSFER"
        ? "BANK_TRANSFER"
        : "CASH";

    return {
      source_order_id: orderRow.id,
      source_order_number: orderRow.order_number,
      warehouse_id: orderRow.warehouse_id,
      warehouse_name: orderRow.warehouse_name,
      customer: {
        id: orderRow.customer_id,
        name: orderRow.customer_name,
        company_name: orderRow.customer_company,
        phone_number: orderRow.customer_phone,
        addresses: savedAddresses,
      },
      customer_address_id: matchedAddress?.id ?? undefined,
      delivery_type:
        orderRow.delivery_method === "LALAMOVE" ? "LALAMOVE" : "INTERNAL",
      payment_arrangement: orderRow.payment_arrangement,
      payment_method: paymentMethod,
      payment_type:
        paymentMethod === "BANK_TRANSFER" ? pastPayment[0]?.payment_type ?? "" : "",
      notes: orderRow.notes ?? "",
      items,
      warnings,
    };
  }

  static async getTotalPendingOrders(warehouseId?: number) {
    const [total] = await db
      .select({ count: count() })
      .from(orders)
      .where(
        and(
          eq(orders.status, "PENDING"),
          warehouseId === undefined ? undefined : eq(orders.warehouse_id, warehouseId),
        ),
      );
    return total?.count ?? 0;
  }
}

export const orderService = OrderService;
