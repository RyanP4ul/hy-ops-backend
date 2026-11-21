import {
  and,
  eq,
  gte,
  isNotNull,
  isNull,
  lt,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { order_items, orders, payment_groups, payments } from "@/db/schema";

export const PAYMENT_METHOD_FILTERS = ["CASH", "BANK_TRANSFER", "CARD"] as const;
export type PaymentMethodFilter = (typeof PAYMENT_METHOD_FILTERS)[number];

export const PAYMENT_STATUS_FILTERS = [
  "UNPAID",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE",
  "UNVERIFIED",
  "REFUNDED",
  "CANCELLED",
] as const;
export type PaymentStatusFilter = (typeof PAYMENT_STATUS_FILTERS)[number];

export const PAYMENT_ENTRY_TYPE_FILTERS = ["SINGLE", "GROUP"] as const;
export type PaymentEntryTypeFilter = (typeof PAYMENT_ENTRY_TYPE_FILTERS)[number];

export type PaymentListFilters = {
  paymentMethod?: PaymentMethodFilter;
  paymentStatus?: PaymentStatusFilter;
  entryType?: PaymentEntryTypeFilter;
  dateFrom?: string;
  dateTo?: string;
};

type RawPaymentFilterQuery = {
  payment_method?: string;
  payment_status?: string;
  entry_type?: string;
  date_from?: string;
  date_to?: string;
};

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MANILA_OFFSET = "+08:00";
const DAY_MS = 24 * 60 * 60 * 1000;

function parseEnumFilter<T extends readonly string[]>(
  raw: string | undefined,
  allowed: T,
): T[number] | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toUpperCase();
  if (!normalized || normalized === "ALL") return undefined;
  return allowed.includes(normalized) ? (normalized as T[number]) : undefined;
}

export function isValidDateOnly(value: string | undefined): value is string {
  if (!value) return false;
  const match = DATE_ONLY_PATTERN.exec(value.trim());
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  return (
    check.getUTCFullYear() === year &&
    check.getUTCMonth() === month - 1 &&
    check.getUTCDate() === day
  );
}

export function parsePaymentListFilters(
  query: RawPaymentFilterQuery,
): PaymentListFilters {
  const paymentMethod = parseEnumFilter(query.payment_method, PAYMENT_METHOD_FILTERS);
  const paymentStatus = parseEnumFilter(query.payment_status, PAYMENT_STATUS_FILTERS);
  const entryType = parseEnumFilter(query.entry_type, PAYMENT_ENTRY_TYPE_FILTERS);

  let dateFrom = isValidDateOnly(query.date_from) ? query.date_from.trim() : undefined;
  let dateTo = isValidDateOnly(query.date_to) ? query.date_to.trim() : undefined;

  if (dateFrom && dateTo && dateFrom > dateTo) {
    [dateFrom, dateTo] = [dateTo, dateFrom];
  }

  return {
    ...(paymentMethod ? { paymentMethod } : {}),
    ...(paymentStatus ? { paymentStatus } : {}),
    ...(entryType ? { entryType } : {}),
    ...(dateFrom ? { dateFrom } : {}),
    ...(dateTo ? { dateTo } : {}),
  };
}

export function manilaDateRangeBounds(
  dateFrom?: string,
  dateTo?: string,
): { start?: Date; endExclusive?: Date } {
  const start = dateFrom ? new Date(`${dateFrom}T00:00:00.000${MANILA_OFFSET}`) : undefined;
  const endExclusive = dateTo
    ? new Date(new Date(`${dateTo}T00:00:00.000${MANILA_OFFSET}`).getTime() + DAY_MS)
    : undefined;
  return { start, endExclusive };
}

export function buildPaymentFilterConditions(
  filters: PaymentListFilters,
): SQL | undefined {
  const conditions: (SQL | undefined)[] = [];

  if (filters.paymentMethod) {
    conditions.push(
      or(
        and(isNotNull(payment_groups.id), eq(payment_groups.payment_method, filters.paymentMethod)),
        and(isNull(payment_groups.id), eq(payments.payment_method, filters.paymentMethod)),
      ),
    );
  }

  if (filters.entryType === "GROUP") {
    conditions.push(isNotNull(payment_groups.id));
  } else if (filters.entryType === "SINGLE") {
    conditions.push(isNull(payment_groups.id));
  }

  if (filters.paymentStatus) {
    const fullyRefunded = sql`${payments.refunded_amount} > 0 and ${payments.amount} = 0`;
    const hasVerifiedOrderTotal = sql<boolean>`exists (
      select 1 from ${order_items}
      where ${order_items.order_id} = ${payments.order_id}
      having count(*) > 0 and bool_and(${order_items.unit_price_snapshot} is not null)
    )`;

    switch (filters.paymentStatus) {
      case "REFUNDED":
        conditions.push(sql`${payments.refunded_amount} > 0`);
        break;
      case "CANCELLED":
        conditions.push(eq(orders.status, "CANCELLED"));
        break;
      case "UNVERIFIED":
        conditions.push(
          and(
            ne(orders.status, "CANCELLED"),
            sql`not (${hasVerifiedOrderTotal})`,
            sql`not (${fullyRefunded})`,
          ),
        );
        break;
      default:
        conditions.push(
          and(
            eq(payments.payment_status, filters.paymentStatus),
            ne(orders.status, "CANCELLED"),
            hasVerifiedOrderTotal,
            sql`not (${fullyRefunded})`,
          ),
        );
        break;
    }
  }

  const { start, endExclusive } = manilaDateRangeBounds(filters.dateFrom, filters.dateTo);
  if (start) {
    conditions.push(
      or(
        and(isNotNull(payment_groups.id), gte(payment_groups.received_at, start)),
        and(isNull(payment_groups.id), gte(payments.received_at, start)),
      ),
    );
  }
  if (endExclusive) {
    conditions.push(
      or(
        and(isNotNull(payment_groups.id), lt(payment_groups.received_at, endExclusive)),
        and(isNull(payment_groups.id), lt(payments.received_at, endExclusive)),
      ),
    );
  }

  const valid = conditions.filter((condition): condition is SQL => condition !== undefined);
  return valid.length ? and(...valid) : undefined;
}
