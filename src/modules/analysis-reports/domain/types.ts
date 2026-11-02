// Internal (server-side) read models. The API sends the slimmer DTOs from ../reports.contract.ts.
import type { DeliveryStatus, DeliveryType, ExpenseStatus, OrderStatus, PaymentArrangement, PaymentMethod, PaymentStatus, StopStatus } from "../reports.contract";

export interface Range { start: number; end: number } // [start, end) epoch ms on Manila day boundaries

export interface DeliveryView {
  id: number; date: string; departureAt: number; type: DeliveryType; status: DeliveryStatus; vehicle: string; driver: string;
  warehouseId: number; cost: number; costStatus: ExpenseStatus | null;
}
export interface ItemView {
  inventoryId: number; productId: number; product: string; variantId: number; variant: string; sku: string; qty: number; line: number | null;
}
export interface OrderView {
  id: number; number: string; at: number; customerId: number; customer: string; warehouseId: number; warehouse: string; status: OrderStatus;
  arrangement: PaymentArrangement; items: ItemView[]; total: number | null; paid: number; balance: number | null; dueAt: number | null;
  payStatus: PaymentStatus; delivery: DeliveryView | null;
}
export interface StopView { id: number; status: StopStatus; deliveredAt: number | null; delivery: DeliveryView; order: OrderView }
export interface PaymentView { kind: "receipt" | "legacy_aggregate" | "refund"; id: number; number: string; method: PaymentMethod; amount: number; at: number; order: OrderView }
export interface EventView { id: number; type: string; reason: string | null; at: number; delivery: DeliveryView }
export interface InventoryView {
  id: number; warehouseId: number; warehouse: string; productId: number; product: string; variantId: number; variant: string; sku: string;
  unit: string; price: number; quantity: number; reserved: number; available: number;
}
