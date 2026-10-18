import { db } from "..";
import { logger } from "../../utils/logger";
import {
  order_items,
  orders,
  OrderItemInsert,
  OrderInsert,
} from "../schema/order";

const now = Math.floor(Date.now() / 1000);

const orderData: OrderInsert[] = [
  {
    customer_id: 1,
    order_number: "ORD-000001",
    payment_arrangement: "NET_30",
    notes: "Pickup at warehouse A counter",
    status: "PENDING",
  },
  {
    customer_id: 1,
    order_number: "ORD-000002",
    payment_arrangement: "NET_30",
    notes: "Deliver to Guiguinto branch",
    status: "PENDING",
  },
  {
    customer_id: 1,
    order_number: "ORD-000003",
    payment_arrangement: "NET_30",
    notes: "Internal stock transfer",
    status: "PENDING",
  },
];

const orderItemData: OrderItemInsert[] = [
  // Order 1 - Tarpaulin C1 x2 and Sakolin 17 x1
  {
    order_id: 1,
    inventory_id: 1,
    quantity: 2,
  },
  {
    order_id: 1,
    inventory_id: 2,
    quantity: 1,
  },
  // Order 2 - Linoleum 1mm x5
  {
    order_id: 2,
    inventory_id: 3,
    quantity: 5,
  },
  // Order 3 - Tarpaulin S4 x3 and Linoleum .40mm x2
  {
    order_id: 3,
    inventory_id: 1,
    quantity: 3,
  },
  {
    order_id: 3,
    inventory_id: 3,
    quantity: 2,
  },
];

export async function orderSeeds() {
  try {
    await db.transaction(async (tx) => {
      await tx.insert(orders).values(orderData).returning();
      await tx.insert(order_items).values(orderItemData).returning();
    });

    logger.info("Order seed completed successfully.");
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Error seeding orders:", error.message);
    }

    throw error;
  }
}
