import { expect, test } from "bun:test";
import { agingBuckets, groupMoney, trend } from "../src/modules/analysis-reports/domain/metrics";
import { buildOrderViews } from "../src/modules/analysis-reports/domain/order-rules";
import { DEFAULT_FILTERS } from "../src/modules/analysis-reports/reports.contract";
import { reportMetadata } from "../src/modules/analysis-reports/services/metadata";
import { DAY } from "../src/utils/time";

const now = Date.parse("2026-10-31T16:00:00Z");
function order(balance: number, dueAt: number | null) {
  const [row] = buildOrderViews([{ id: 1, number: "ORD-1", createdAt: new Date(now), customerId: 1, company: "Customer", contact: "Contact", warehouseId: 1, warehouse: "Warehouse", status: "PENDING", arrangement: "NET_30" }],
    [{ orderId: 1, inventoryId: 1, productId: 1, product: "Product", variantId: 1, variant: "Variant", sku: "SKU", qty: 1, price: "1.00" }], new Map(), new Map(), now);
  return { ...row, balance, dueAt };
}

test("financial groups and trends reconcile centavos, including refunds", () => {
  const rows = [{ method: "CASH", amount: .1 }, { method: "CASH", amount: .2 }, { method: "CASH", amount: -.01 }];
  expect(groupMoney(rows, row => row.method, row => row.amount)).toEqual([{ name: "CASH", value: .29 }]);
  expect(trend(rows.map(row => ({ at: now, v: row.amount })), "day")).toEqual([{ name: "2026-11-01", value: .29 }]);
});

test("aging includes recently overdue balances and separates 30/60/90-day boundaries", () => {
  const rows = [order(.1, now - 1), order(.2, now - DAY * 30), order(.3, now - DAY * 30 - 1), order(.4, now - DAY * 60 - 1), order(.5, now - DAY * 90 - 1), order(.6, now), order(.7, null)];
  expect(agingBuckets(rows, now).map(row => row.value)).toEqual([.6, .3, .3, .4, .5, .7]);
});

test("export metadata resolves Manila month and carries the exact filter scope", () => {
  expect(reportMetadata("Payment", { ...DEFAULT_FILTERS, preset: "mtd", warehouses: ["2"], paymentMethods: ["CASH"] }, now, 10)).toMatchObject({ from: "2026-11-01", to: "2026-11-01", generatedAt: "2026-10-31T16:00:00.000Z", timezone: "Asia/Manila", currency: "PHP", filters: ["warehouses: 2", "paymentMethods: CASH"] });
});
