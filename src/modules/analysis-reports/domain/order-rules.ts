// ---- BUSINESS RULES TO CONFIRM ----------------------------------------------------------------
// Due dates remain derived from the configured payment terms; order totals use saved item prices.
import type { PaymentArrangement, PaymentStatus } from "../reports.contract";
import { DAY, dayStart } from "../../../utils/time";
import { minorUnitsToMoney, moneyToMinorUnits } from "../../../utils/money";
import type { DeliveryView, ItemView, OrderView } from "./types";

/** Days after order creation that payment is due; "delivery" = the day after the order's latest delivery date. */
export const DUE_TERMS: Record<PaymentArrangement, number | "delivery"> = {
  FULLY_PAID: 0,
  PARTIALLY_PAID: 30,
  PAY_ON_DELIVERY: "delivery",
  NET_30: 30,
};

/** payments.payment_status values that count as money received. */
export const RECEIVED_PAYMENT_STATUSES = [
  "PAID",
  "PARTIALLY_PAID",
] as const;

export interface OrderRaw {
  salesChannel?: string;
  id: number;
  number: string;
  createdAt: Date;
  customerId: number;
  company: string;
  contact: string;
  warehouseId: number;
  warehouse: string | null;
  status: OrderView["status"];
  arrangement: PaymentArrangement | null;
}
export interface ItemRaw {
  orderId: number;
  inventoryId: number;
  productId: number;
  product: string;
  variantId: number;
  variant: string;
  sku: string;
  qty: number;
  price: string | null;
}

export function buildOrderViews(
  rows: OrderRaw[],
  items: ItemRaw[],
  paidByOrder: Map<number, number>,
  deliveryByOrder: Map<number, DeliveryView>,
  now: number,
): OrderView[] {
  const itemsByOrder = new Map<number, ItemView[]>();
  for (const i of items) {
    const list = itemsByOrder.get(i.orderId) ?? [];
    list.push({
      inventoryId: i.inventoryId,
      productId: i.productId,
      product: i.product,
      variantId: i.variantId,
      variant: i.variant,
      sku: i.sku,
      qty: i.qty,
      line:
        i.price === null
          ? null
          : Number(
              minorUnitsToMoney(
                moneyToMinorUnits(i.price) * BigInt(i.qty),
              ),
            ),
    });
    itemsByOrder.set(i.orderId, list);
  }

  return rows.map((o) => {
    const lines = itemsByOrder.get(o.id) ?? [];
    const delivery = deliveryByOrder.get(o.id) ?? null;
    const arrangement = o.arrangement ?? "NET_30";
    const terms = DUE_TERMS[arrangement];
    const at = o.createdAt.getTime();
    const dueAt =
      terms === "delivery"
        ? delivery
          ? dayStart(delivery.date) + DAY
          : null
        : at + terms * DAY;
    const total =
      lines.length > 0 && lines.every((i) => i.line !== null)
        ? Number(
            minorUnitsToMoney(
              lines.reduce(
                (sum, i) => sum + moneyToMinorUnits(i.line ?? 0),
                0n,
              ),
            ),
          )
        : null;
    const paid = paidByOrder.get(o.id) ?? 0;
    const balance =
      total === null
        ? null
        : Number(
            minorUnitsToMoney(
              moneyToMinorUnits(total) > moneyToMinorUnits(paid)
                ? moneyToMinorUnits(total) - moneyToMinorUnits(paid)
                : 0n,
            ),
          );
    const overdue =
      o.status !== "CANCELLED" &&
      balance !== null &&
      balance > 0 &&
      dueAt !== null &&
      dueAt < now;
    const payStatus: PaymentStatus =
      total === null
        ? "UNVERIFIED"
        : balance === 0 && total > 0
        ? "PAID"
        : overdue
          ? "OVERDUE"
          : paid > 0
            ? "PARTIALLY_PAID"
            : "UNPAID";
    return {
      salesChannel: o.salesChannel === "WALK_IN" ? "WALK_IN" : "STANDARD",
      id: o.id,
      number: o.number,
      at,
      customerId: o.customerId,
      customer: o.company !== "none" ? o.company : o.contact,
      warehouseId: o.warehouseId,
      warehouse: o.warehouse ?? "Unknown",
      status: o.status,
      arrangement,
      items: lines,
      total,
      paid,
      balance: o.status === "CANCELLED" ? 0 : balance,
      dueAt,
      payStatus,
      delivery,
    };
  });
}
