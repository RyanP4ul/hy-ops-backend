import { expect, test } from "bun:test";
import {
  buildPaymentFilterConditions,
  isValidDateOnly,
  manilaDateRangeBounds,
  parsePaymentListFilters,
} from "../src/modules/payments/filters";

test("parsePaymentListFilters normalizes valid enum filters and ignores ALL or unknown values", () => {
  expect(
    parsePaymentListFilters({
      payment_method: " bank_transfer ",
      payment_status: "partially_paid",
      entry_type: "group",
      date_from: "2026-11-01",
      date_to: "2026-11-21",
    }),
  ).toEqual({
    paymentMethod: "BANK_TRANSFER",
    paymentStatus: "PARTIALLY_PAID",
    entryType: "GROUP",
    dateFrom: "2026-11-01",
    dateTo: "2026-11-21",
  });

  expect(
    parsePaymentListFilters({
      payment_method: "ALL",
      payment_status: "UNKNOWN",
      entry_type: "",
      date_from: "2026-02-30",
      date_to: "not-a-date",
    }),
  ).toEqual({});
});

test("parsePaymentListFilters swaps inverted date ranges", () => {
  expect(
    parsePaymentListFilters({
      date_from: "2026-11-21",
      date_to: "2026-11-01",
    }),
  ).toEqual({
    dateFrom: "2026-11-01",
    dateTo: "2026-11-21",
  });
});

test("isValidDateOnly rejects impossible calendar dates", () => {
  expect(isValidDateOnly("2026-02-28")).toBe(true);
  expect(isValidDateOnly("2024-02-29")).toBe(true);
  expect(isValidDateOnly("2026-02-29")).toBe(false);
  expect(isValidDateOnly("2026-13-01")).toBe(false);
  expect(isValidDateOnly("2026-1-1")).toBe(false);
});

test("manilaDateRangeBounds computes half-open Asia/Manila UTC instants", () => {
  const { start, endExclusive } = manilaDateRangeBounds("2026-11-01", "2026-11-01");
  expect(start?.toISOString()).toBe("2026-10-31T16:00:00.000Z");
  expect(endExclusive?.toISOString()).toBe("2026-11-01T16:00:00.000Z");
});

test("buildPaymentFilterConditions returns undefined when empty and SQL when any filter is set", () => {
  expect(buildPaymentFilterConditions({})).toBeUndefined();
  expect(
    buildPaymentFilterConditions({
      paymentMethod: "CASH",
      paymentStatus: "REFUNDED",
      entryType: "SINGLE",
      dateFrom: "2026-11-01",
      dateTo: "2026-11-21",
    }),
  ).toBeDefined();
});
