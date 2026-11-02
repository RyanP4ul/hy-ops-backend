import { ARRAY_FILTER_KEYS, type Filters, type ReportMetadata, type ReportType } from "../reports.contract";
import { rangeDays, rangeOf } from "../domain/filters";
import { manilaDay } from "../../../utils/time";

const bases: Record<ReportType, string> = {
  Sales: "Whole matching orders by creation date. Sales exclude cancelled orders. Saved checkout prices only; missing prices are Unverified. Paid is current net retained receipts; cancelled balances are zero.",
  Inventory: "Current stock snapshot, not historical stock. Only warehouse and product filters select stock rows. Date and other order filters apply only to units sold in the on-screen report, not stock quantities. Available = on hand minus reserved.",
  Payment: "Cashflow = receipts on collection date minus refunds on refund date, including cancelled orders. Legacy aggregate receipts use their recorded date. Balances are current balances of non-cancelled orders created in the period, not an as-of ledger. Missing saved prices are Unverified.",
  Delivery: "Stops by scheduled delivery date; summary excludes cancelled runs. One detail row per stop.",
  Customer: "Non-cancelled orders by creation date; current net retained receipts and balances. Saved checkout prices only; missing prices are Unverified.",
};

export function reportMetadata(type: ReportType, filters: Filters, now: number, threshold: number): ReportMetadata {
  const range = rangeOf(filters, now);
  const { from } = rangeDays(range);
  const active = ARRAY_FILTER_KEYS.flatMap(key => filters[key].length ? [`${key}: ${filters[key].join(", ")}`] : []);
  if (filters.overdueOnly) active.push("Overdue orders only");
  if (type === "Inventory") active.push(`Low-stock threshold: ${threshold}`);
  return { from, to: manilaDay(range.end - 1), generatedAt: new Date(now).toISOString(), timezone: "Asia/Manila", currency: "PHP", basis: bases[type], filters: active };
}

export function metadataRows(type: ReportType, metadata: ReportMetadata): (string | number)[][] {
  return [
    ["Report", `${type} report`],
    ["Period (inclusive, Asia/Manila)", `${metadata.from} to ${metadata.to}`],
    ["Generated at (UTC)", metadata.generatedAt],
    ["Currency", metadata.currency],
    ["Filters (IDs / stored values)", metadata.filters.join("; ") || "All records in scope"],
    ["Basis", metadata.basis],
  ];
}
