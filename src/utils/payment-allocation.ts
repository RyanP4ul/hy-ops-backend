import { WorkflowError } from "./workflow-error";

/** Proportional allocation in minor units, with deterministic largest remainders. */
export function allocatePayment(amount: bigint, totals: bigint[]): bigint[] {
  const total = totals.reduce((sum, value) => sum + value, 0n);
  if (amount <= 0n || totals.length === 0 || totals.some(value => value < 0n) || amount > total) {
    throw new WorkflowError("Combined payment must be positive and cannot exceed the combined order total.");
  }
  const amounts = totals.map(value => amount * value / total);
  const rank = totals.map((value, index) => ({ index, remainder: amount * value % total }))
    .sort((a, b) => a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1);
  let remaining = amount - amounts.reduce((sum, value) => sum + value, 0n);
  for (const { index } of rank) {
    if (remaining === 0n) break;
    amounts[index] += 1n;
    remaining -= 1n;
  }
  return amounts;
}
