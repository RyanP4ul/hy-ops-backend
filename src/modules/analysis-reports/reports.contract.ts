/**
 * API CONTRACT — the single source of truth for what the reports API accepts and returns.
 * Pure TypeScript, no imports. A byte-identical copy lives in the frontend at
 * `features/analysis-reports/api/contract.ts` (in a monorepo, import it from one place instead).
 */

// ---- Enums (mirror the pgEnums in your Drizzle schema) ----
export const PAYMENT_ARRANGEMENTS = ["FULLY_PAID", "PARTIALLY_PAID", "PAY_ON_DELIVERY", "NET_30"] as const;
export const ORDER_STATUSES = ["PENDING", "PROCESSING", "SCHEDULING", "SCHEDULED", "IN_TRANSIT", "COMPLETED", "CANCELLED"] as const;
export const PAYMENT_STATUSES = ["UNPAID", "PARTIALLY_PAID", "PAID", "OVERDUE", "UNVERIFIED"] as const;
export const PAYMENT_METHODS = ["CASH", "BANK_TRANSFER", "CARD"] as const;
export const DELIVERY_STATUSES = ["scheduled", "in_transit", "completed", "returning", "cancelled"] as const;
export const DELIVERY_TYPES = ["INTERNAL", "LALAMOVE", "PICKUP"] as const;
export const STOP_STATUSES = ["pending", "delivered", "failed"] as const;
export const EXPENSE_STATUSES = ["pending", "approved", "rejected"] as const;

export type PaymentArrangement = (typeof PAYMENT_ARRANGEMENTS)[number];
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export type DeliveryType = (typeof DELIVERY_TYPES)[number];
export type StopStatus = (typeof STOP_STATUSES)[number];
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

// ---- Report-level enums ----
export const DATE_PRESETS = ["today", "7d", "30d", "90d", "mtd", "ytd", "custom"] as const;
export const REPORT_TYPES = ["Sales", "Inventory", "Payment", "Delivery", "Customer"] as const;
export const EXPORT_FORMATS = ["csv", "xlsx"] as const;
export const GRAINS = ["day", "week", "month"] as const;

export type DatePreset = (typeof DATE_PRESETS)[number];
export type ReportType = (typeof REPORT_TYPES)[number];
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export type Grain = (typeof GRAINS)[number];

// ---- Filters ----
export interface Filters {
  preset: DatePreset;
  from: string; // YYYY-MM-DD (Asia/Manila), only used when preset === "custom"
  to: string; // YYYY-MM-DD, inclusive
  customers: string[]; // customer ids
  products: string[]; // product ids
  warehouses: string[]; // warehouse ids
  arrangements: string[];
  payStatuses: string[];
  orderStatuses: string[];
  deliveryStatuses: string[];
  deliveryTypes: string[];
  vehicles: string[]; // plate numbers
  paymentMethods: string[];
  overdueOnly: boolean;
}
export type ArrayFilterKey = Exclude<keyof Filters, "preset" | "from" | "to" | "overdueOnly">;
export const ARRAY_FILTER_KEYS: readonly ArrayFilterKey[] = [
  "customers", "products", "warehouses", "arrangements", "payStatuses", "orderStatuses",
  "deliveryStatuses", "deliveryTypes", "vehicles", "paymentMethods",
];
export const DEFAULT_FILTERS: Filters = {
  preset: "90d", from: "", to: "", customers: [], products: [], warehouses: [], arrangements: [], payStatuses: [],
  orderStatuses: [], deliveryStatuses: [], deliveryTypes: [], vehicles: [], paymentMethods: [], overdueOnly: false,
};

// ---- Shared DTO pieces ----
export interface Point { name: string; value: number }
export interface Opt { value: string; label: string }
/** `delta*` fields are % change vs the previous equal-length period; null when there is no previous value. */
export type Delta = number | null;

export interface OrderRow {
  id: number; number: string; at: number; customerId: number; customer: string; warehouse: string; itemCount: number;
  total: number | null; paid: number; balance: number | null; arrangement: PaymentArrangement; dueAt: number | null;
  payStatus: PaymentStatus; status: OrderStatus;
}

// ---- Responses ----
export interface OptionsResponse { customers: Opt[]; products: Opt[]; warehouses: Opt[]; vehicles: Opt[] }

export interface OverviewResponse {
  kpis: {
    revenue: number | null; revenueDelta: Delta; orders: number; ordersDelta: Delta; cash: number; cashDelta: Delta;
    outstanding: number | null; delivered: number; deliveredDelta: Delta; failureRate: number;
  };
  trend: Record<Grain, Point[]>;
  ordersByStatus: Point[];
  paymentStatus: Point[];
  recentOrders: OrderRow[];
}

export interface SalesResponse {
  kpis: { revenue: number | null; revenueDelta: Delta; orders: number; cancelled: number; aov: number | null; units: number };
  byProduct: Point[]; byWarehouse: Point[]; byCustomer: Point[];
  orders: OrderRow[];
}

export interface StockRow {
  id: number; product: string; variant: string; sku: string; warehouse: string; unit: string; price: number;
  quantity: number; reserved: number; available: number; unitsSold: number; lastSoldAt: number | null;
}
export interface InventoryResponse { rows: StockRow[]; topSellers: Point[] }

export interface PaymentsResponse {
  kpis: { received: number; refunded: number; cash: number; cashDelta: Delta; outstanding: number | null; overdue: number | null; partiallyPaid: number };
  byMethod: Point[]; byArrangement: Point[]; aging: Point[];
  openBalances: OrderRow[]; openBalanceCount: number;
}

export interface DeliveryIssueRow { id: number; date: string; deliveryId: number; vehicle: string; driver: string; type: string; reason: string | null }
export interface DeliveriesResponse {
  kpis: { deliveries: number; deliveriesDelta: Delta; delivered: number; failed: number; failureRate: number; avgMinutes: number; approvedCost: number };
  byType: Point[]; byVehicle: Point[]; byStatus: Point[];
  issues: DeliveryIssueRow[];
}

export interface CustomerRow { id: number; name: string; orders: number; sales: number | null; paid: number; balance: number | null; lastOrderAt: number }
export interface CustomersResponse {
  kpis: { customers: number; repeat: number; aov: number | null; outstanding: number | null };
  rows: CustomerRow[];
}

export interface PreviewResponse {
  type: ReportType;
  metadata: ReportMetadata;
  summary: { label: string; value: number | null; format: "currency" | "count" | "percent" }[];
  rowCount: number;
}

export interface ReportMetadata {
  from: string; to: string; generatedAt: string; timezone: "Asia/Manila"; currency: "PHP";
  basis: string; filters: string[];
}
