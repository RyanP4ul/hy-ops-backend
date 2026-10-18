import { db } from "@/db/index";
import {
  customers,
  inventory,
  product_variants,
  products,
  users,
} from "@/db/schema";
import { order_items, OrderInsert, orders } from "@/db/schema/order";
import { and, asc, count, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { PaymentService } from "../payments/service";
import { PaymentMethodType } from "@/db/schema/payment";

type SortField = "id" | "name";
type SortOrder = "asc" | "desc";

export abstract class OrderService {
  static async getOrders(
    page: number = 1,
    limit: number = 10,
    search: string = "",
    delivery_type: string = "",
    sort_by: string = "id:desc",
  ) {
    const is_search_empty = search.length === 0;
    const offset = is_search_empty ? Math.max(page * limit, 0) : 0;
    const [sortField, sortOrder] = sort_by.split(":");

    const whereQuery = ilike(users.name, `%${search}%`);

    const [total_result] = await db
      .select({ count: count() })
      .from(orders)
      .leftJoin(users, eq(orders.customer_id, users.id))
      .where(and(whereQuery));

    const order_rows = await db
      .select({
        id: orders.id,
        product_number: orders.order_number,
        customer_name: users.name,
        email: users.email,
        customer_company: customers.company_name,
        status: orders.status,
        version: orders.version,
      })
      .from(orders)
      .leftJoin(customers, eq(orders.customer_id, customers.id))
      .leftJoin(users, eq(customers.user_id, users.id))
      .where(and(whereQuery))
      .orderBy(this.SortByField(sortField as SortField, sortOrder as SortOrder))
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
          price: product_variants.price,
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
        items: order_item,
        item_count: order_item.length,
        total_quantity: order_item.reduce(
          (acc, item) => acc + item.quantity,
          0,
        ),
        total: order_item.reduce(
          (acc, item) => acc + item.quantity * Number(item.price),
          0,
        ),
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
        customer_id: orders.customer_id,
        customer_name: users.name,
        // description: orders.description,
        status: orders.status,
        notes: orders.notes,
        version: orders.version,
      })
      .from(orders)
      .leftJoin(users, eq(orders.customer_id, users.id))
      .leftJoin(customers, eq(users.id, customers.user_id))
      .where(eq(orders.id, orderId));

    if (!order_row) return null;

    const order_item = await db
      .select({
        id: order_items.id,
        product_name: products.name,
        product_variant_name: product_variants.name,
        product_variant_sku: product_variants.sku,
        description: product_variants.description,
        quantity: order_items.quantity,
        price: product_variants.price,
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
      items: order_item,
    };
  }

  static SortByField(field: SortField, order: SortOrder) {
    const columnMap = {
      id: orders.id,
      name: products.name,
    } as const;

    const column = columnMap[field];

    return order === "asc" ? asc(column) : desc(column);
  }

  static async getOrderDetailsByIds(orderIds: number[]) {
    const rows = await db
      .select({
        id: orders.id,
        order_number: orders.order_number,
        customer_company: customers.company_name,
        destination: customers.address,
        item_count: count(order_items.id),
        total: sql<number>`coalesce(sum(${order_items.quantity} * ${product_variants.price}), 0)`,
      })
      .from(orders)
      .leftJoin(customers, eq(orders.customer_id, customers.id))
      .leftJoin(order_items, eq(orders.id, order_items.order_id))
      .leftJoin(inventory, eq(order_items.inventory_id, inventory.id))
      .leftJoin(
        product_variants,
        eq(inventory.product_variant_id, product_variants.id),
      )
      .where(inArray(orders.id, orderIds))
      .groupBy(orders.id, customers.company_name, customers.address);

    return rows.map((row) => ({
      ...row,
      total: Number(row.total),
    }));
  }

  static async createOrder(
    data: Omit<
      OrderInsert & {
        items: {
          inventory_id: number;
          quantity: number;
        }[];
        payment_method: "BANK_TRANSFER" | "CASH" | "GCASH";
        amount_paid: number;
      },
      "order_number" | "status" | "created_at" | "updated_at"
    >,
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

    if (data.items.length === 0) {
      throw new Error("Order must have at least one item");
    }

    return await db.transaction(async (tx) => {
      const [order_count] = await tx
        .select({ count: count() })
        .from(orders)
        .where(eq(orders.customer_id, data.customer_id));

      // if (order_count && order_count.count >= 1) {
      //   throw new Error("Customer has reached the maximum number of orders");
      // }

      const [new_order] = await tx
        .insert(orders)
        .values({
          order_number: "",
          customer_id: data.customer_id,
          payment_arrangement: data.payment_arrangement,
          notes: data.notes || "",
        })
        .returning({
          id: orders.id,
        });

      if (!new_order) {
        throw new Error("Failed to create order");
      }

      const order_number = `ORD-${String(new_order.id).padStart(6, "0")}`;

      await tx
        .update(orders)
        .set({ order_number: order_number })
        .where(eq(orders.id, new_order.id));

      PaymentService.createPayment({
        payment_number: `PAY-${String(new_order.id).padStart(6, "0")}`,
        order_id: new_order.id,
        customer_id: data.customer_id,
        payment_method: data.payment_method as PaymentMethodType,
        amount: String(data.amount_paid),
      });

      for (const item of data.items) {
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
          });
        }
      }

      return {
        message: `Order ${order_number} has been created successfully.`,
      };
    });
  }

  static async processOrder(orderId: number, version: number) {
    return await db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.version, version)));

      if (!order) {
        throw new Error("Order not found");
      }

      if (order.status !== "PENDING") {
        throw new Error("Order is not pending");
      }

      await tx
        .update(orders)
        .set({ status: "PROCESSING", version: order.version + 1 })
        .where(eq(orders.id, orderId));

      return {
        message: `Order ${order.order_number} is now being processed.`,
      };
    });
  }

  static async deliveryOrder(orderId: number, version: number) {
    return await db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.version, version)));

      if (!order) {
        throw new Error("Order not found");
      }

      if (order.status !== "PROCESSING") {
        throw new Error("Order is not processing");
      }

      await tx
        .update(orders)
        .set({ status: "READY_FOR_DELIVERY", version: order.version + 1 })
        .where(eq(orders.id, orderId));

      return {
        message: `Order ${order.order_number} is now ready for delivery.`,
      };
    });
  }

  static async cancelOrder(orderId: number, version: number) {
    return await db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.version, version)));

      if (!order) {
        throw new Error("Order not found");
      }

      if (["PENDING", "PROCESSING"].indexOf(order.status) === -1) {
        throw new Error("Only pending and processing orders can be cancelled");
      }

      await tx
        .update(orders)
        .set({ status: "CANCELLED", version: order.version + 1 })
        .where(and(eq(orders.id, orderId), eq(orders.version, version)));

      return {
        message: `Order ${order.order_number} has been cancelled.`,
      };
    });
  }

  static async getAllReadyForDeliveryOrders(
    page: number = 1,
    limit: number = 10,
    search: string = "",
  ) {
    const is_search_empty = search.length === 0;
    const offset = is_search_empty ? Math.max(page * limit, 0) : 0;

    const whereQuery = ilike(users.name, `%${search}%`);

    const [total_result] = await db
      .select({ count: count() })
      .from(orders)
      .leftJoin(customers, eq(orders.customer_id, customers.id))
      .leftJoin(users, eq(customers.user_id, users.id))
      .where(and(whereQuery, eq(orders.status, "READY_FOR_DELIVERY")));

    const rows = await db
      .select({
        id: orders.id,
        order_number: orders.order_number,
        customer_name: users.name,
        customer_company: customers.company_name,
        payment_arrangement: orders.payment_arrangement,
        status: orders.status,
        customer_address: customers.address,
        customer_phone: customers.phone_number,
        shipping_recipient: orders.shipping_recipient,
        shipping_phone: orders.shipping_phone,
        shipping_address: orders.shipping_address,
      })
      .from(orders)
      .leftJoin(customers, eq(orders.customer_id, customers.id))
      .leftJoin(users, eq(customers.user_id, users.id))
      .where(and(whereQuery, eq(orders.status, "READY_FOR_DELIVERY")))
      .offset(offset)
      .limit(limit);

    return {
      rows,
      total: total_result?.count ?? 0,
    };
  }

  static async getAllOrderForCombobox(
    page: number = 1,
    limit: number = 10,
    search: string = "",
  ) {
    const is_search_empty = search.length === 0;
    const offset = is_search_empty ? Math.max(page * limit, 0) : 0;

    const whereQuery = ilike(users.name, `%${search}%`);

    const [total_result] = await db
      .select({ count: count() })
      .from(orders)
      .leftJoin(customers, eq(orders.customer_id, customers.id))
      .leftJoin(users, eq(customers.user_id, users.id))
      .where(and(whereQuery));

    const rows = await db
      .select({
        id: orders.id,
        order_number: orders.order_number,
        customer_name: users.name,
        customer_company: customers.company_name,
        payment_arrangement: orders.payment_arrangement,
        status: orders.status,
        customer_address: customers.address,
        customer_phone: customers.phone_number,
        shipping_recipient: orders.shipping_recipient,
        shipping_phone: orders.shipping_phone,
        shipping_address: orders.shipping_address,
      })
      .from(orders)
      .leftJoin(customers, eq(orders.customer_id, customers.id))
      .leftJoin(users, eq(customers.user_id, users.id))
      .where(and(whereQuery))
      .offset(offset)
      .limit(limit);

    return {
      rows,
      total: total_result?.count ?? 0,
    };
  }
}

export const orderService = OrderService;
