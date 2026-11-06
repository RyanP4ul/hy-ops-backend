import { WorkflowError } from "../../utils/workflow-error";
import { stockTransaction, type StockTransaction } from "../inventory/transaction";
import type { CreateOrderInput, OrderBatchInput } from "./model";
import { allocatePayment } from "../../utils/payment-allocation";
import { coordinates } from "../../utils/coordinates";
import { changeOrderStock } from "./stock";
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
  warehouses,
} from "@/db/schema";
import { order_items, OrderInsert, orders, order_groups } from "@/db/schema/order";
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
import { getOrderCombinedPayment } from "../payments/groups";
import { PaymentService } from "../payments/service";
import { PaymentMethodType } from "@/db/schema/payment";
import { InvoiceService } from "../invoice/service";
import { invoices } from "@/db/schema/invoice";
import { minorUnitsToMoney, moneyToMinorUnits } from "../../utils/money";

const orderGroupFields = {
  order_group_id: orders.order_group_id,
  order_group_position: orders.order_group_position,
  order_group_number: sql<string | null>`(select group_number from order_groups where id = ${orders.order_group_id})`,
  order_group_size: sql<number>`(select count(*)::int from orders as members where members.order_group_id = ${orders.order_group_id})`.mapWith(Number),
};

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
  static async saveShippingAddress(customerId: number, data: import("./model").SavedShippingAddress) {
    const point = coordinates(data.latitude, data.longitude);
    if (!point) throw new WorkflowError("Confirm valid coordinates for this shipping address.");
    return db.transaction(async (tx) => {
      const [customer] = await tx.select({ id: customers.id }).from(customers)
        .innerJoin(users, eq(users.id, customers.user_id))
        .where(and(eq(customers.id, customerId), eq(users.is_archived, false)))
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
        customer_name: users.name,
        customer_company: customers.company_name,
        shipping_address: orders.shipping_address,
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
    const whereQuery = and(or(ilike(users.name, `%${search}%`), ilike(orders.order_number, `%${search}%`), ilike(orderGroupFields.order_group_number, `%${search}%`), ilike(customers.company_name, `%${search}%`), ilike(orders.shipping_address, `%${search}%`)), validStatus ? eq(orders.status, validStatus) : undefined,
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
        ...orderGroupFields,
        warehouse_id: orders.warehouse_id,
        warehouse_name: warehouses.name,
        customer_name: users.name,
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
        ...orderGroupFields,
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
        payment_type: sql<string | null>`(select ${payments.payment_type} from ${payments} where ${payments.order_id} = ${orders.id} order by ${payments.id} limit 1)`,
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
      combined_payment: await getOrderCombinedPayment(orderId),
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
        ...orderGroupFields,
        customer_company: customers.company_name,
        shipping_address: orders.shipping_address,
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

  static async createOrder(data: CreateOrderInput) {
    return stockTransaction(tx => this.createOrderInTransaction(tx, data));
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

    const [warehouse] = await tx.select({ id: warehouses.id }).from(warehouses).where(and(eq(warehouses.id, data.warehouse_id), eq(warehouses.is_archived, false))).for("share");
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

    const payment = await PaymentService.createPayment(tx, {
      payment_number: `PAY-${String(new_order.id).padStart(6, "0")}`,
      order_id: new_order.id,
      customer_id: data.customer_id,
      payment_method: data.payment_method as PaymentMethodType,
      payment_type: data.payment_method === "CASH" ? null : data.payment_type?.trim() || null,
      amount: minorUnitsToMoney(amountPaidMinor),
      payment_status: paymentStatus,
      received_at: amountPaidMinor > 0n ? receivedAt ?? new Date() : null,
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
      payment_id: payment.id,
      message: `Order ${order_number} has been created successfully.`,
    };
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

  static async getReadyOrderGroup(groupId: string, warehouseId: number) {
    const members = await db.select({ id: orders.id, warehouse_id: orders.warehouse_id, status: orders.status, ...orderGroupFields,
      order_number: orders.order_number, shipping_address: orders.shipping_address,
      shipping_latitude: orders.shipping_latitude, shipping_longitude: orders.shipping_longitude,
    }).from(orders).where(eq(orders.order_group_id, groupId)).orderBy(asc(orders.order_group_position));
    if (!members.some(row => row.warehouse_id === warehouseId)) throw new WorkflowError("Order group not found in this warehouse.", 404);
    if (members.some(row => row.warehouse_id !== warehouseId)) throw new WorkflowError("All orders in this group must belong to the selected warehouse.");
    if (members.some(row => row.status !== "SCHEDULING")) throw new WorkflowError("All orders in this group must have Scheduling status before the group can be scheduled.");
    return { rows: members, total_members: members.length, group_number: members[0]!.order_group_number };
  }

  static async getSchedulingEntries(page = 0, limit = 10, search = "", warehouseId?: number) {
    page = Number.isSafeInteger(page) && page >= 0 ? page : 0;
    limit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 10;
    const key = sql<string>`coalesce(${orders.order_group_id}::text, 'order-' || ${orders.id}::text)`;
    const match = `%${search.trim()}%`;
    const predicate = and(eq(orders.status, "SCHEDULING"),
      warehouseId === undefined ? undefined : eq(orders.warehouse_id, warehouseId),
      search.trim() ? or(ilike(users.name, match), ilike(customers.company_name, match),
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
      ...orderGroupFields, customer_name: users.name, customer_company: customers.company_name,
      payment_arrangement: orders.payment_arrangement, status: orders.status, shipping_address: orders.shipping_address,
      shipping_latitude: orders.shipping_latitude, shipping_longitude: orders.shipping_longitude, version: orders.version,
    }).from(orders).leftJoin(customers, eq(customers.id, orders.customer_id)).leftJoin(users, eq(users.id, customers.user_id))
      .where(and(or(groupIds.length ? inArray(orders.order_group_id, groupIds) : undefined,
        singleIds.length ? inArray(orders.id, singleIds) : undefined),
        warehouseId === undefined ? undefined : eq(orders.warehouse_id, warehouseId)))
      .orderBy(asc(orders.order_group_position), asc(orders.id));
    const rows = entries.map(entry => {
      const children = members.filter(member => entry.group_id ? member.order_group_id === entry.group_id : member.id === entry.id);
      const first = children[0]!;
      const total = entry.group_id ? first.order_group_size : 1;
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

    const whereQuery = or(ilike(users.name, `%${search}%`), ilike(orders.order_number, `%${search}%`), ilike(orderGroupFields.order_group_number, `%${search}%`));

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
        ...orderGroupFields,
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
      search.trim() ? or(ilike(users.name, `%${search.trim()}%`), ilike(orders.order_number, `%${search.trim()}%`), ilike(orderGroupFields.order_group_number, `%${search.trim()}%`)) : undefined,
    );
    const [total] = await db.select({ count: count() }).from(orders)
      .leftJoin(customers, eq(orders.customer_id, customers.id))
      .leftJoin(users, eq(customers.user_id, users.id)).where(predicate);
    const rows = await db.select({
      id: orders.id, order_number: orders.order_number,
        ...orderGroupFields,
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
