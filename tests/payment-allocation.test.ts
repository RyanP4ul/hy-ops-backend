import { expect, test } from "bun:test";
import { allocatePayment } from "../src/utils/payment-allocation";

test("combined payments allocate exact centavos proportionally with deterministic rounding", () => {
  expect(allocatePayment(1000n, [1234n, 2468n])).toEqual([333n, 667n]);
  expect(allocatePayment(1n, [1234n, 1234n])).toEqual([1n, 0n]);
  expect(allocatePayment(3702n, [1234n, 2468n])).toEqual([1234n, 2468n]);
  expect(allocatePayment(1n, [0n, 10n])).toEqual([0n, 1n]);
  for (let amount = 1n; amount <= 103n; amount++) {
    const allocations = allocatePayment(amount, [1n, 2n, 100n]);
    expect(allocations.reduce((sum, value) => sum + value, 0n)).toBe(amount);
    expect(allocations.every((value, index) => value >= 0n && value <= [1n, 2n, 100n][index])).toBe(true);
  }
});
test("combined payments reject zero, negative, excessive and invalid totals", () => {
  for (const amount of [0n, -1n, 101n]) expect(() => allocatePayment(amount, [100n])).toThrow();
  expect(() => allocatePayment(1n, [])).toThrow();
  expect(() => allocatePayment(1n, [-1n, 3n])).toThrow();
});
