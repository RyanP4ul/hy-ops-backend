import { WorkflowError } from "../../utils/workflow-error";
import { stockTransaction } from "../inventory/transaction";
import { coordinates } from "../../utils/coordinates";
import { changeOrderStock } from "./stock";
import { db } from "@/db/index";
import {
  customer_addresses,
  customers,
  inventory,
  payments,
  deliveries,
  deliveries_stops,
  product_variants,
  products,
  settings,
  users,
  warehouses,
} from "@/db/schema";
import { order_items, OrderInsert, orders } from "@/db/schema/order";
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { PaymentService } from "../payments/service";
import { PaymentMethodType } from "@/db/schema/payment";
import { InvoiceService } from "../invoice/service";
import { invoices } from "@/db/schema/invoice";
import { minorUnitsToMoney, moneyToMinorUnits } from "../../utils/money";

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
  reasonCode: "CUSTOMER_ORDER_LIMIT_REACHED" | null;
  activeOrderCount: number;
  maxActiveOrders: number;
  checkedAt: string;
  message: string | null;
};

function getCustomerOrderLimit(settingValue: string | undefined): number {
  const limit = Number(settingValue);
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new WorkflowError("Customer order limit setting is missing or invalid.");
  }
  return limit;
}

function buildCustomerOrderEligibility(
  activeOrderCount: number,
  maxActiveOrders: number,
): CustomerOrderEligibility {
  const eligible = activeOrderCount < maxActiveOrders;
  return {
    eligible,
    reasonCode: eligible ? null : "CUSTOMER_ORDER_LIMIT_REACHED",
    activeOrderCount,
    maxActiveOrders,
    checkedAt: new Date().toISOString(),
    message: eligible
      ? null
      : `This customer already has the maximum of ${maxActiveOrders} active orders. Complete or cancel an existing order before creating another.`,
  };
}

export class CustomerOrderLimitReachedError extends Error {
  readonly code = "CUSTOMER_ORDER_LIMIT_REACHED";
  readonly eligibility: CustomerOrderEligibility;

  constructor(eligibility: CustomerOrderEligibility) {
    super(eligibility.message ?? "Customer order limit reached.");
    this.name = "CustomerOrderLimitReachedError";
    this.eligibility = eligibility;
  }
}

export abstract class OrderService {
  static async getCustomerOrderEligibility(customerId: number) {
    const [customer] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.id, customerId));

    if (!customer) throw new WorkflowError("Customer not found.");

    const [[limitSetting], [activeOrders]] = await Promise.all([
      db
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.name, "customer_order_limit")),
      db
        .select({ count: count() })
        .from(orders)
        .where(
          and(
            eq(orders.customer_id, customerId),
            inArray(orders.status, ACTIVE_ORDER_STATUSES),
          ),
        ),
    ]);

    return buildCustomerOrderEligibility(
      activeOrders?.count ?? 0,
      getCustomerOrderLimit(limitSetting?.value),
    );
  }

  static async getOrderTableRowById(id: number) {
    const [row] = await db
      .select({
        id: orders.id,
        product_number: orders.order_number,
        customer_name: users.name,
        customer_company: customers.company_name,
        status: orders.status,
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
  ) {
    page = Number.isSafeInteger(page) && page >= 0 ? page : 0;
    limit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 10;
    const offset = page * limit;
    const [sortField, sortOrder] = sort_by.split(":");

    const statuses = ["PENDING", "PROCESSING", "SCHEDULING", "SCHEDULED", "IN_TRANSIT", "COMPLETED", "CANCELLED"] as const;
    const validStatus = statuses.find((value) => value === status);
    const latestDeliveryType = sql<string>`(select ${deliveries.delivery_type} from ${deliveries_stops} inner join ${deliveries} on ${deliveries.id} = ${deliveries_stops.delivery_id} where ${deliveries_stops.order_id} = ${orders.id} order by ${deliveries.id} desc limit 1)`;
    const whereQuery = and(or(ilike(users.name, `%${search}%`), ilike(orders.order_number, `%${search}%`), ilike(customers.company_name, `%${search}%`)), validStatus ? eq(orders.status, validStatus) : undefined,
      ["INTERNAL", "LALAMOVE", "PICKUP"].includes(delivery_type) ? sql`${latestDeliveryType} = ${delivery_type}` : undefined);

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
        warehouse_id: orders.warehouse_id,
        warehouse_name: warehouses.name,
        customer_name: users.name,
        email: users.email,
        customer_company: customers.company_name,
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

  static async getOrderById(orderId: number) {
    const [order_row] = await db
      .select({
        id: orders.id,
        order_number: orders.order_number,
        warehouse_id: orders.warehouse_id,
        warehouse_name: warehouses.name,
        payment_arrangement: orders.payment_arrangement,
        shipping_recipient: orders.shipping_recipient,
        shipping_phone: orders.shipping_phone,
        shipping_address: orders.shipping_address,
        shipping_latitude: orders.shipping_latitude,
        shipping_longitude: orders.shipping_longitude,
        customer_address_id: orders.shipping_address_source_id,
        delivery_type: sql<string | null>`(select ${deliveries.delivery_type} from ${deliveries_stops} inner join ${deliveries} on ${deliveries.id} = ${deliveries_stops.delivery_id} where ${deliveries_stops.order_id} = ${orders.id} order by ${deliveries.id} desc limit 1)`,
        payment_method: sql<string | null>`(select ${payments.payment_method} from ${payments} where ${payments.order_id} = ${orders.id} order by ${payments.id} limit 1)`,
        amount_paid: sql<number>`coalesce((select sum(${payments.amount}) from ${payments} where ${payments.order_id} = ${orders.id}), 0)`.mapWith(Number),
        customer_id: orders.customer_id,
        customer_name: users.name,
        // description: orders.description,
        status: orders.status,
        notes: orders.notes,
        version: orders.version,
      })
      .from(orders)
      .leftJoin(customers, eq(orders.customer_id, customers.id))
      .leftJoin(users, eq(customers.user_id, users.id))
      .leftJoin(warehouses, eq(orders.warehouse_id, warehouses.id))
      .where(eq(orders.id, orderId));

    if (!order_row) return null;

    const order_item = await db
      .select({
        id: order_items.id,
        inventory_id: order_items.inventory_id,
        product_id: inventory.product_id,
        product_name: products.name,
        product_variant_name: product_variants.name,
        product_variant_sku: product_variants.sku,
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
      .where(eq(order_items.order_id, orderId));

    return {
      ...order_row,
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
      warehouse_name: warehouses.name,
      customer_name: users.name,
      item_count: sql`(select count(*) from ${order_items} where ${order_items.order_id} = ${orders.id})`,
      total: sql`(select case when bool_and(${order_items.unit_price_snapshot} is not null) then sum(${order_items.quantity} * ${order_items.unit_price_snapshot}) else null end from ${order_items} where ${order_items.order_id} = ${orders.id})`,
    } as const;

    const column = Object.hasOwn(columnMap, field) ? columnMap[field] : orders.id;

    return order === "asc" ? asc(column) : desc(column);
  }

  static async getOrderDetailsByIds(orderIds: number[]) {
    const rows = await db
      .select({
        id: orders.id,
        order_number: orders.order_number,
        customer_company: customers.company_name,
        destination: orders.shipping_address,
        shipping_latitude: orders.shipping_latitude,
        shipping_longitude: orders.shipping_longitude,
        item_count: sql<number>`(
          select count(*) from ${order_items}
          where ${order_items.order_id} = ${orders.id}
        )`.mapWith(Number),
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
      .where(inArray(orders.id, orderIds));

    return rows.map((row) => ({
      ...row,
      total: row.total === null ? null : Number(row.total),
    }));
  }

  static async createOrder(
    data: import("./model").OrderType & { items: { inventory_id: number; quantity: number }[] },
  ) {
    // {
    //   "customer_id": 1,
    //   "delivery_type": "INTERNAL",
    //   "notes": "",
    //   "items": [
    //     {
    //       "inventory_id": 14,
    //       "quantity": 1
    //     }
    //   ]
    // }

    if (data.items.some((item) => !Number.isSafeInteger(item.quantity) || item.quantity <= 0)) throw new WorkflowError("Order quantities must be positive integers.");
    if (data.items.length === 0) {
      throw new WorkflowError("Order must have at least one item");
    }

    return await stockTransaction(async (tx) => {
      const [warehouse] = await tx.select({ id: warehouses.id }).from(warehouses).where(and(eq(warehouses.id, data.warehouse_id), eq(warehouses.is_archived, false))).for("share");
      if (!warehouse) throw new WorkflowError("Choose an active warehouse.");
      const [customer] = await tx
        .select({ id: customers.id })
        .from(customers)
        .where(eq(customers.id, data.customer_id))
        .for("update");
      if (!customer) throw new WorkflowError("Customer not found.");

      const [limitSetting] = await tx
        .select({ value: settings.value })
        .from(settings)
        .where(eq(settings.name, "customer_order_limit"));
      const [activeOrders] = await tx
        .select({ count: count() })
        .from(orders)
        .where(
          and(
            eq(orders.customer_id, data.customer_id),
            inArray(orders.status, ACTIVE_ORDER_STATUSES),
          ),
        );
      const eligibility = buildCustomerOrderEligibility(
        activeOrders?.count ?? 0,
        getCustomerOrderLimit(limitSetting?.value),
      );
      if (!eligibility.eligible) {
        throw new CustomerOrderLimitReachedError(eligibility);
      }

      let customer_recipient: string;
      let customer_phone: string;
      let customer_address: string;
      let destination = coordinates(data.shipping_latitude, data.shipping_longitude);
      let addressSourceId: number | null = null;
      if ((data.shipping_latitude !== undefined || data.shipping_longitude !== undefined) && !destination) throw new WorkflowError("Provide a valid latitude and longitude pair.");

      if (data.is_custom_shipping) {
        customer_recipient = data.shipping_recipient?.trim() ?? "";
        customer_phone = data.shipping_phone?.trim() ?? "";
        customer_address = data.shipping_address?.trim() ?? "";
        if (!customer_recipient || !customer_phone || !customer_address) {
          throw new WorkflowError(
            "A shipping recipient, phone number, and address are required.",
          );
        }
      } else {
        const [customerQuery] = await tx
          .select({
            name: users.name,
            phone_number: customers.phone_number,
          })
          .from(customers)
          .innerJoin(users, eq(customers.user_id, users.id))
          .where(eq(customers.id, data.customer_id));
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
        const selectedAddress = data.customer_address_id
          ? savedAddresses.find(
              (savedAddress) => savedAddress.id === data.customer_address_id,
            )
          : savedAddresses.length === 1
            ? savedAddresses[0]
            : undefined;

        if (!selectedAddress) {
          throw new WorkflowError(
            savedAddresses.length === 0
              ? "This customer has no saved shipping address. Enter a different address."
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
          inArray(
            inventory.id,
            [...new Set(data.items.map((item) => item.inventory_id))],
          ),
        )
        .orderBy(asc(inventory.id))
        .for("update");
      const priceByInventory = new Map(
        currentPrices.map((row) => [row.inventory_id, row.price]),
      );

      for (const item of data.items) {
        const currentPrice = priceByInventory.get(item.inventory_id);
        if (currentPrice === undefined) {
          throw new WorkflowError(
            `Inventory item ${item.inventory_id} is unavailable for this order.`,
          );
        }
        const unitPriceSnapshot = minorUnitsToMoney(
          moneyToMinorUnits(currentPrice),
        );

        const [order_item] = await tx
          .select()
          .from(order_items)
          .where(
            and(
              eq(order_items.order_id, new_order.id),
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
                eq(order_items.order_id, new_order.id),
                eq(order_items.inventory_id, item.inventory_id),
              ),
            );
        } else {
          await tx.insert(order_items).values({
            order_id: new_order.id,
            inventory_id: item.inventory_id,
            quantity: item.quantity,
            unit_price_snapshot: unitPriceSnapshot,
            price_source: "checkout",
          });
        }
      }

      await changeOrderStock(tx, new_order.id, data.warehouse_id, "reserve");

      const [orderTotal] = await tx
        .select({
          total: sql<string>`coalesce(sum(${order_items.quantity} * ${order_items.unit_price_snapshot}), 0)`,
        })
        .from(order_items)
        .where(eq(order_items.order_id, new_order.id));

      const amountPaidMinor = moneyToMinorUnits(data.amount_paid);
      const totalMinor = moneyToMinorUnits(orderTotal?.total ?? "0");

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

      await PaymentService.createPayment(tx, {
        payment_number: `PAY-${String(new_order.id).padStart(6, "0")}`,
        order_id: new_order.id,
        customer_id: data.customer_id,
        payment_method: data.payment_method as PaymentMethodType,
        amount: minorUnitsToMoney(amountPaidMinor),
        payment_status: paymentStatus,
        received_at: amountPaidMinor > 0n ? new Date() : null,
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

      return {
        id: new_order.id,
        message: `Order ${order_number} has been created successfully.`,
      };
    });
  }

  static async processOrder(orderId: number, version: number) {
    return await db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.version, version))).for("update");

      if (!order) {
        throw new WorkflowError("Order not found");
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
    return await db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.version, version))).for("update");

      if (!order) {
        throw new WorkflowError("Order not found");
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

  static async cancelOrder(orderId: number, version: number) {
    return await stockTransaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.version, version))).for("update");

      if (!order) {
        throw new WorkflowError("Order not found");
      }

      if (["PENDING", "PROCESSING"].indexOf(order.status) === -1) {
        throw new WorkflowError("Only pending and processing orders can be cancelled");
      }

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
    const [updated] = await db.update(orders).set({ notes, version: sql`${orders.version} + 1`, updated_at: new Date() })
      .where(and(eq(orders.id, orderId), eq(orders.version, version), inArray(orders.status, ["PENDING", "PROCESSING"]))).returning({ id: orders.id });
    if (!updated) throw new WorkflowError("Only current pending or processing orders can be edited. Refresh and try again.");
    return { message: "Order notes updated.", id: updated.id };
  }

  static async setDestination(orderId: number, version: number, latitude: number, longitude: number) {
    const point = coordinates(latitude, longitude);
    if (!point) throw new WorkflowError("Provide valid destination coordinates; (0, 0) is not a verified destination.");
    return db.transaction(async (tx) => {
      const [order] = await tx.select().from(orders).where(eq(orders.id, orderId)).for("update");
      if (!order || order.version !== version) throw new WorkflowError("Order changed. Refresh and try again.");
      if (!["PENDING", "PROCESSING", "SCHEDULING"].includes(order.status)) throw new WorkflowError("Destination can only be confirmed before scheduling.");
      await tx.update(orders).set({ shipping_latitude: point.latitude, shipping_longitude: point.longitude, version: order.version + 1, updated_at: new Date() }).where(eq(orders.id, orderId));
      return { message: "Destination coordinates saved.", id: orderId };
    });
  }

  static async getAllReadyForDeliveryOrders(
    page: number = 1,
    limit: number = 10,
    search: string = "",
    warehouseId?: number,
  ) {
    const offset = Math.max(page * limit, 0);

    const whereQuery = or(ilike(users.name, `%${search}%`), ilike(orders.order_number, `%${search}%`));

    const [total_result] = await db
      .select({ count: count() })
      .from(orders)
      .leftJoin(customers, eq(orders.customer_id, customers.id))
      .leftJoin(users, eq(customers.user_id, users.id))
      .where(and(whereQuery, eq(orders.status, "SCHEDULING"), warehouseId === undefined ? undefined : eq(orders.warehouse_id, warehouseId)));

    const rows = await db
      .select({
        id: orders.id,
        warehouse_id: orders.warehouse_id,
        order_number: orders.order_number,
        customer_name: users.name,
        customer_company: customers.company_name,
        payment_arrangement: orders.payment_arrangement,
        status: orders.status,
        customer_address: orders.shipping_address,
        customer_phone: customers.phone_number,
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
      .where(and(whereQuery, eq(orders.status, "SCHEDULING"), warehouseId === undefined ? undefined : eq(orders.warehouse_id, warehouseId)))
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
      warehouse_id > 0 ? eq(orders.warehouse_id, warehouse_id) : undefined,
      search.trim() ? or(ilike(users.name, `%${search.trim()}%`), ilike(orders.order_number, `%${search.trim()}%`)) : undefined,
    );
    const [total] = await db.select({ count: count() }).from(orders)
      .leftJoin(customers, eq(orders.customer_id, customers.id))
      .leftJoin(users, eq(customers.user_id, users.id)).where(predicate);
    const rows = await db.select({
      id: orders.id, order_number: orders.order_number,
      customer_name: users.name, customer_company: customers.company_name,
      payment_arrangement: orders.payment_arrangement, status: orders.status,
      customer_address: orders.shipping_address, customer_phone: customers.phone_number,
      shipping_recipient: orders.shipping_recipient, shipping_phone: orders.shipping_phone,
      shipping_address: orders.shipping_address, shipping_latitude: orders.shipping_latitude,
      shipping_longitude: orders.shipping_longitude, version: orders.version,
      latitude: orders.shipping_latitude, longitude: orders.shipping_longitude,
    }).from(orders).leftJoin(customers, eq(orders.customer_id, customers.id))
      .leftJoin(users, eq(customers.user_id, users.id)).where(predicate)
      .orderBy(desc(orders.id)).offset(Math.max(page, 0) * limit).limit(limit);
    return { rows, total: total?.count ?? 0 };
  }

  static async getTotalOrders() {
    const [total] = await db.select({ count: count() }).from(orders);
    return total?.count ?? 0;
  }

  static async getTotalPendingOrders() {
    const [total] = await db
      .select({ count: count() })
      .from(orders)
      .where(eq(orders.status, "PENDING"));
    return total?.count ?? 0;
  }
}

export const orderService = OrderService;
