// "Generate report": a preview (summary + row count) and a downloadable CSV / XLSX built from the same datasets as the tabs.
import ExcelJS from "exceljs";
import type {
  ExportFormat,
  Filters,
  PreviewResponse,
  ReportType,
} from "../reports.contract";
import { deliveryMetrics, orderMetrics, sumMoney, sumBy } from "../domain/metrics";
import { manilaDay } from "../../../utils/time";
import { inventoryFor, ordersFor, paymentsFor, stopsFor } from "./datasets";
import { buildCustomerRows } from "./customers.service";
import { metadataRows, reportMetadata } from "./metadata";

export const DEFAULT_LOW_STOCK = 10;

type Cell = string | number;
interface Table {
  columns: { key: string; label: string }[];
  rows: Record<string, Cell>[];
}
interface Report {
  summary: PreviewResponse["summary"];
  table: Table;
}

const col = (key: string, label = key) => ({ key, label });
const when = (t: number | null) => (t ? manilaDay(t) : "");
const exportAmount = (value: number | null): Cell =>
  value === null ? "Unverified" : value;

async function build(
  type: ReportType,
  f: Filters,
  now: number,
  threshold: number,
): Promise<Report> {
  switch (type) {
    case "Sales": {
      const orders = await ordersFor(f, now);
      const m = orderMetrics(orders);
      return {
        summary: [
          { label: "Sales revenue", value: m.revenue, format: "currency" },
          { label: "Orders", value: m.count, format: "count" },
          { label: "Average order value", value: m.aov, format: "currency" },
        ],
        table: {
          columns: [
            col("number", "Order"),
            col("salesChannel", "Sale type"),
            col("date", "Date"),
            col("customer", "Customer"),
            col("warehouse", "Warehouse"),
            col("items", "Items"),
            col("total", "Total"),
            col("paid", "Paid"),
            col("balance", "Balance"),
            col("arrangement", "Arrangement"),
            col("payStatus", "Payment status"),
            col("status", "Order status"),
          ],
          rows: orders.map((o) => ({
            number: o.number,
            salesChannel: o.salesChannel === "WALK_IN" ? "Walk-in sale" : "Standard order",
            date: manilaDay(o.at),
            customer: o.customer,
            warehouse: o.warehouse,
            items: o.items.length,
            total: exportAmount(o.total),
            paid: o.paid,
            balance: exportAmount(o.balance),
            arrangement: o.arrangement,
            payStatus: o.payStatus,
            status: o.status,
          })),
        },
      };
    }
    case "Inventory": {
      const stock = await inventoryFor(f);
      return {
        summary: [
          { label: "Stock rows", value: stock.length, format: "count" },
          {
            label: "Low stock",
            value: stock.filter(
              (r) => r.available > 0 && r.available <= threshold,
            ).length,
            format: "count",
          },
          {
            label: "Out of stock",
            value: stock.filter((r) => r.available <= 0).length,
            format: "count",
          },
        ],
        table: {
          columns: [
            col("product", "Product"),
            col("variant", "Variant"),
            col("sku", "SKU"),
            col("warehouse", "Warehouse"),
            col("unit", "Unit"),
            col("price", "Price"),
            col("quantity", "On hand"),
            col("reserved", "Reserved"),
            col("available", "Available"),
          ],
          rows: stock.map((r) => ({
            product: r.product,
            variant: r.variant,
            sku: r.sku,
            warehouse: r.warehouse,
            unit: r.unit,
            price: r.price,
            quantity: r.quantity,
            reserved: r.reserved,
            available: r.available,
          })),
        },
      };
    }
    case "Payment": {
      const [orders, pays] = await Promise.all([
        ordersFor(f, now),
        paymentsFor(f, now),
      ]);
      const m = orderMetrics(orders);
      return {
        summary: [
          { label: "Gross receipts", value: sumMoney(pays.filter(p => p.amount > 0), p => p.amount), format: "currency" },
          { label: "Refunds", value: Math.abs(sumMoney(pays.filter(p => p.amount < 0), p => p.amount)), format: "currency" },
          {
            label: "Net cashflow",
            value: sumMoney(pays, (p) => p.amount),
            format: "currency",
          },
          { label: "Outstanding", value: m.outstanding, format: "currency" },
          { label: "Overdue", value: m.overdue, format: "currency" },
        ],
        table: {
          columns: [
            col("number", "Payment"),
            col("date", "Transaction date (Manila)"),
            col("kind", "Transaction type"),
            col("order", "Order"),
            col("customer", "Customer"),
            col("method", "Method"),
            col("amount", "Amount"),
          ],
          rows: pays.map((p) => ({
            number: p.number,
            date: manilaDay(p.at),
            kind: p.kind,
            order: p.order.number,
            customer: p.order.customer,
            method: p.method,
            amount: p.amount,
          })),
        },
      };
    }
    case "Delivery": {
      const stops = await stopsFor(f, now);
      const dm = deliveryMetrics(stops);
      return {
        summary: [
          { label: "Deliveries", value: dm.deliveries.length, format: "count" },
          { label: "Failed stops", value: dm.failed, format: "count" },
          { label: "Failure rate", value: dm.rate, format: "percent" },
        ],
        table: {
          columns: [
            col("date", "Scheduled"),
            col("delivery", "Delivery #"),
            col("vehicle", "Vehicle"),
            col("driver", "Driver"),
            col("type", "Type"),
            col("deliveryStatus", "Delivery status"),
            col("order", "Order"),
            col("customer", "Customer"),
            col("stopStatus", "Stop status"),
            col("deliveredAt", "Delivered"),
          ],
          rows: stops.map((s) => ({
            date: s.delivery.date,
            delivery: s.delivery.id,
            vehicle: s.delivery.vehicle,
            driver: s.delivery.driver,
            type: s.delivery.type,
            deliveryStatus: s.delivery.status,
            order: s.order.number,
            customer: s.order.customer,
            stopStatus: s.status,
            deliveredAt: when(s.deliveredAt),
          })),
        },
      };
    }
    case "Customer": {
      const m = orderMetrics(await ordersFor(f, now));
      const rows = buildCustomerRows(m.live);
      return {
        summary: [
          { label: "Customers", value: rows.length, format: "count" },
          { label: "Total sales", value: m.revenue, format: "currency" },
          { label: "Outstanding", value: m.outstanding, format: "currency" },
        ],
        table: {
          columns: [
            col("name", "Customer"),
            col("orders", "Orders"),
            col("sales", "Sales"),
            col("paid", "Payments"),
            col("balance", "Outstanding"),
            col("last", "Last order"),
          ],
          rows: rows.map((c) => ({
            name: c.name,
            orders: c.orders,
            sales: exportAmount(c.sales),
            paid: c.paid,
            balance: exportAmount(c.balance),
            last: manilaDay(c.lastOrderAt),
          })),
        },
      };
    }
  }
}

export async function getPreview(
  type: ReportType,
  f: Filters,
  threshold = DEFAULT_LOW_STOCK,
  now = Date.now(),
): Promise<PreviewResponse> {
  const { summary, table } = await build(type, f, now, threshold);
  return { type, summary, rowCount: table.rows.length, metadata: reportMetadata(type, f, now, threshold) };
}

// A CSV cell starting with = + - @ can run as a formula when opened in Excel; names and notes are user-entered, so neutralise them.
const csvCell = (v: Cell) => {
  let s = String(v);
  if (typeof v === "string" && /^\s*[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function buildExport(
  type: ReportType,
  format: ExportFormat,
  f: Filters,
  threshold = DEFAULT_LOW_STOCK,
  now = Date.now(),
) {
  const { table, summary } = await build(type, f, now, threshold);
  const metadata = reportMetadata(type, f, now, threshold);
  const filename = `${type.toLowerCase()}-report-${manilaDay(now)}.${format}`;

  if (format === "csv") {
    const lines = [
      ...metadataRows(type, metadata).map(row => row.map(csvCell).join(",")),
      "",
      table.columns.map((c) => csvCell(c.label)).join(","),
      ...table.rows.map((r) =>
        table.columns.map((c) => csvCell(r[c.key] ?? "")).join(","),
      ),
    ];
    return {
      filename,
      mime: "text/csv; charset=utf-8",
      body: "\uFEFF" + lines.join("\r\n"),
    }; // BOM so Excel reads UTF-8 (₱, accents)
  }

  const wb = new ExcelJS.Workbook();
  const analysis = wb.addWorksheet("Analysis summary");
  analysis.columns = [
    { header: "Metric", key: "label", width: 28 },
    { header: "Value", key: "value", width: 22 },
    { header: "Format", key: "format", width: 16 },
  ];
  analysis.addRows(summary.map(row => ({ ...row, value: row.value ?? "Unverified" })));
  analysis.getRow(1).font = { bold: true };
  const ws = wb.addWorksheet(type);
  ws.columns = table.columns.map((c) => ({
    header: c.label,
    key: c.key,
    width: Math.max(14, c.label.length + 4),
  }));
  ws.addRows(table.rows);
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];
  const details = wb.addWorksheet("Report details");
  details.columns = [{ width: 36 }, { width: 100 }];
  details.addRows(metadataRows(type, metadata));
  details.getColumn(1).font = { bold: true };
  details.getColumn(2).alignment = { wrapText: true, vertical: "top" };
  return {
    filename,
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    body: await wb.xlsx.writeBuffer(),
  };
}
