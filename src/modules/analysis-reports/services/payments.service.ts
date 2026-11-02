import type { Filters, PaymentsResponse } from "../reports.contract";
import { agingBuckets, delta, groupMoney, groupSum, orderMetrics, sumMoney, toOrderRow } from "../domain/metrics";
import { ordersFor, paymentsFor } from "./datasets";

const OPEN_BALANCE_ROWS = 8;

export async function getPayments(f: Filters, now = Date.now()): Promise<PaymentsResponse> {
  const [orders, pays, prevPays] = await Promise.all([ordersFor(f, now), paymentsFor(f, now), paymentsFor(f, now, 1)]);
  const m = orderMetrics(orders);
  const cash = sumMoney(pays, (p) => p.amount);
  const open = m.live
    .filter((o) => o.balance === null || o.balance > 0)
    .sort(
      (a, b) =>
        Number(b.payStatus === "OVERDUE") -
          Number(a.payStatus === "OVERDUE") ||
        (b.balance ?? -1) - (a.balance ?? -1),
    );

  return {
    kpis: { received: sumMoney(pays.filter((p) => p.amount > 0), (p) => p.amount), refunded: Math.abs(sumMoney(pays.filter((p) => p.amount < 0), (p) => p.amount)), cash, cashDelta: delta(cash, sumMoney(prevPays, (p) => p.amount)), outstanding: m.outstanding, overdue: m.overdue, partiallyPaid: m.live.filter((o) => o.paid > 0 && o.balance !== null && o.balance > 0).length },
    byMethod: groupMoney(pays, (p) => p.method, (p) => p.amount),
    byArrangement: groupSum(m.live, (o) => o.arrangement, () => 1),
    aging: agingBuckets(orders, now),
    openBalances: open.slice(0, OPEN_BALANCE_ROWS).map(toOrderRow),
    openBalanceCount: open.length,
  };
}
