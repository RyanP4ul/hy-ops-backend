import { preserveReceiptBaseline } from "./receipts";
import { WorkflowError } from "../../utils/workflow-error";
import { db } from "@/db/index";
import {
  customers,
  order_items,
  users,
  orders,
  payment_refunds,
  payment_receipts,
  payment_groups,
  payment_group_allocations,
} from "@/db/schema";
import { PaymentInsert, payments } from "@/db/schema/payment";
import {
  and,
  asc,
  count,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  ne,
  or,
} from "drizzle-orm";
import { sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { PaymentUpdate } from "./model";
import { minorUnitsToMoney, moneyToMinorUnits } from "../../utils/money";

type PaymentReader = Pick<typeof db, "select">;
const grossReceived = sql<string>`${payments.amount} + ${payments.refunded_amount}`;

export abstract class PaymentService {
  static async getRefunds(paymentNumber: string) {
    return db.select({ id: payment_refunds.id, amount: payment_refunds.amount, reason: payment_refunds.reason, created_at: payment_refunds.created_at, actor: users.name })
      .from(payment_refunds).innerJoin(payments, eq(payments.id, payment_refunds.payment_id))
      .innerJoin(users, eq(users.id, payment_refunds.actor_id)).where(eq(payments.payment_number, paymentNumber)).orderBy(desc(payment_refunds.id));
  }

  static async refund(data: { payment_number: string; amount: number; version: number; reason: string; request_id: string }, actorId: number) {
    const amount = moneyToMinorUnits(data.amount);
    if (amount <= 0n || !data.reason.trim()) throw new WorkflowError("A positive refund amount and a reason are required.");
    return db.transaction(async (tx) => {
      const [actor] = await tx.select().from(users).where(eq(users.id, actorId)).for("update");
      if (!actor || !actor.is_active || actor.is_archived || actor.role !== "admin") throw new WorkflowError("Only an active administrator can record refunds.", 403);
      const [payment] = await tx.select().from(payments).where(eq(payments.payment_number, data.payment_number)).for("update");
      if (!payment) throw new WorkflowError("Payment not found.", 404);
      const [prior] = await tx.select().from(payment_refunds).where(eq(payment_refunds.request_id, data.request_id));
      if (prior) {
        if (prior.payment_id !== payment.id || moneyToMinorUnits(prior.amount) !== amount || prior.reason !== data.reason.trim() || prior.actor_id !== actorId) throw new WorkflowError("This refund request ID was already used for a different operation.", 409);
        return { message: "Refund already recorded.", payment_number: payment.payment_number };
      }
      if (payment.version !== data.version) throw new WorkflowError("Payment changed. Refresh before recording a refund.", 409);
      const net = moneyToMinorUnits(payment.amount);
      if (amount > net) throw new WorkflowError("Refund exceeds the net amount received.", 409);
      const remaining = net - amount;
      await preserveReceiptBaseline(tx, payment);
      await tx.insert(payment_refunds).values({ payment_id: payment.id, actor_id: actorId, request_id: data.request_id, amount: minorUnitsToMoney(amount), reason: data.reason.trim() });
      await tx.update(payments).set({ amount: minorUnitsToMoney(remaining), refunded_amount: minorUnitsToMoney(moneyToMinorUnits(payment.refunded_amount) + amount),
        payment_status: remaining === 0n ? "UNPAID" : "PARTIALLY_PAID", version: payment.version + 1, updated_at: new Date() }).where(eq(payments.id, payment.id));
      return { message: "Refund recorded.", payment_number: payment.payment_number };
    });
  }

  static async getPaymentTableRowByNumber(paymentNumber: string) {
    const rows = await this.paymentRows(db).where(eq(payments.payment_number, paymentNumber));
    return this.withVerifiedStatuses(rows)[0] ?? null;
  }

  static async getPayments(
    page = 0,
    limit = 10,
    search = "",
    sortBy = "id:desc",
  ) {
    const [sortField, sortOrder] = sortBy.split(":");
    const searchQuery = this.paymentSearch(search);
    const [totalResult] = await db
      .select({ count: count() })
      .from(payments)
      .leftJoin(payment_group_allocations, eq(payment_group_allocations.payment_id, payments.id))
      .leftJoin(payment_groups, eq(payment_groups.id, payment_group_allocations.group_id))
      .leftJoin(customers, eq(payments.customer_id, customers.id))
      .leftJoin(users, eq(customers.user_id, users.id))
      .leftJoin(orders, eq(payments.order_id, orders.id))
      .where(searchQuery);

    const rows = await this.paymentRows(db)
      .where(searchQuery)
      .orderBy(this.sortByField(sortField, sortOrder))
      .limit(limit)
      .offset(Math.max(page * limit, 0));

    return { rows: this.withVerifiedStatuses(rows), total: Number(totalResult?.count ?? 0) };
  }

  static async getGroupedPayments(page = 0, limit = 10, search = "", sortBy = "id:desc") {
    page = Number.isSafeInteger(page) && page >= 0 ? page : 0;
    limit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 10;
    const [sortField, sortOrder] = sortBy.split(":");
    const direction = sortOrder === "asc" ? asc : desc;
    const entryKey = sql`coalesce(${payment_groups.id}::text, 'payment-' || ${payments.id}::text)`;

    return db.transaction(async (tx) => {
      const entries = tx.select({
        payment_id: sql<number>`max(${payments.id})`.mapWith(Number).as("payment_id"),
        group_id: payment_groups.id,
        payment_number: sql<string>`coalesce(${payment_groups.payment_number}, max(${payments.payment_number}))`.as("entry_number"),
        received_amount: sql<string>`coalesce(${payment_groups.amount}, max(${grossReceived}))`.as("received_amount"),
        received_at: sql<Date | null>`coalesce(${payment_groups.received_at}, max(${payments.received_at}))`.mapWith(payments.received_at).as("entry_received_at"),
        payment_method: payment_groups.payment_method,
        payment_type: payment_groups.payment_type,
        reference_number: payment_groups.reference_number,
      })
        .from(payments)
        .leftJoin(payment_group_allocations, eq(payment_group_allocations.payment_id, payments.id))
        .leftJoin(payment_groups, eq(payment_groups.id, payment_group_allocations.group_id))
        .leftJoin(customers, eq(payments.customer_id, customers.id))
        .leftJoin(users, eq(customers.user_id, users.id))
        .leftJoin(orders, eq(payments.order_id, orders.id))
        .where(this.paymentSearch(search))
        .groupBy(entryKey, payment_groups.id)
        .as("payment_entries");

      const sortable = {
        payment_number: entries.payment_number,
        received_amount: entries.received_amount,
        received_at: entries.received_at,
      };
      const sortColumn = Object.hasOwn(sortable, sortField)
        ? sortable[sortField as keyof typeof sortable]
        : entries.payment_id;
      const [countResult] = await tx.select({ total: count() }).from(entries);
      const total = countResult?.total ?? 0;
      const pageEntries = await tx.select().from(entries)
        .orderBy(sql`${direction(sortColumn)} nulls last`, desc(entries.payment_id))
        .limit(limit)
        .offset(page * limit);
      if (!pageEntries.length) return { rows: [], total };

      const groupIds = pageEntries.flatMap(entry => entry.group_id ? [entry.group_id] : []);
      const singleIds = pageEntries.filter(entry => !entry.group_id).map(entry => entry.payment_id);
      const members = this.withVerifiedStatuses(await this.paymentRows(tx)
        .where(or(inArray(payment_groups.id, groupIds), inArray(payments.id, singleIds)))
        .orderBy(asc(payments.id)));
      const paymentsById = new Map(members.map(member => [member.id, member]));
      const membersByGroup = Map.groupBy(members, member => member.combined_payment_number);

      const rows = pageEntries.map(entry => {
        const payment = paymentsById.get(entry.payment_id)!;
        if (!entry.group_id) return { entry_type: "SINGLE" as const, payment };
        return {
          entry_type: "GROUP" as const,
          group_id: entry.group_id,
          payment_number: entry.payment_number,
          customer_id: payment.customer_id,
          customer_name: payment.customer_name,
          received_amount: entry.received_amount,
          received_at: entry.received_at,
          payment_method: entry.payment_method!,
          payment_type: entry.payment_type,
          reference_number: entry.reference_number,
          orders: membersByGroup.get(entry.payment_number)!,
        };
      });
      return { rows, total };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
  }

  private static paymentSearch(search: string) {
    if (!search) return undefined;
    const match = `%${search}%`;
    return or(
      ilike(payments.payment_number, match),
      ilike(payment_groups.payment_number, match),
      ilike(payment_groups.reference_number, match),
      ilike(payments.reference_number, match),
      ilike(users.name, match),
      ilike(orders.order_number, match),
      ilike(sql`${payments.payment_status}::text`, match),
    );
  }

  private static paymentRows(reader: PaymentReader) {
    const paymentTotals = alias(payments, "payment_totals");
    const orderTotals = reader
      .select({
        orderId: order_items.order_id,
        total: sql<string | null>`
        case
          when count(*) > 0 and bool_and(${order_items.unit_price_snapshot} is not null)
          then sum(${order_items.quantity} * ${order_items.unit_price_snapshot})::text
          else null
        end
      `.as("order_total"),
      })
      .from(order_items)
      .groupBy(order_items.order_id)
      .as("order_totals");

    const paidTotals = reader
      .select({
        orderId: paymentTotals.order_id,
        total: sql<string>`coalesce(sum(${paymentTotals.amount}), 0)`.as(
          "total",
        ),
      })
      .from(paymentTotals)
      .groupBy(paymentTotals.order_id)
      .as("paid_totals");
    return reader
      .select({
        id: payments.id,
        payment_number: payments.payment_number,
        combined_payment_number: payment_groups.payment_number,
        combined_payment_amount: payment_groups.amount,
        combined_payment_allocation: payment_group_allocations.amount,
        combined_payment_reference: payment_groups.reference_number,
        order_id: payments.order_id,
        order_number: orders.order_number,
        customer_id: payments.customer_id,
        customer_name: users.name,
        payment_method: payments.payment_method,
        payment_type: payments.payment_type,
        payment_status: payments.payment_status,
        amount: payments.amount,
        refunded_amount: payments.refunded_amount,
        gross_received: grossReceived,
        order_status: orders.status,
        remaining_amount: sql<string | null>`case
          when ${orders.status} = 'CANCELLED' then 0
          when ${orderTotals.total} is null then null
          else greatest(${orderTotals.total}::numeric - coalesce(${paidTotals.total}, 0)::numeric, 0)
        end`,
        reference_number: payments.reference_number,
        received_at: payments.received_at,
        version: payments.version,
      })
      .from(payments)
      .leftJoin(payment_group_allocations, eq(payment_group_allocations.payment_id, payments.id))
      .leftJoin(payment_groups, eq(payment_groups.id, payment_group_allocations.group_id))
      .leftJoin(customers, eq(payments.customer_id, customers.id))
      .leftJoin(users, eq(customers.user_id, users.id))
      .leftJoin(orderTotals, eq(payments.order_id, orderTotals.orderId))
      .leftJoin(orders, eq(payments.order_id, orders.id))
      .leftJoin(paidTotals, eq(payments.order_id, paidTotals.orderId));
  }

  private static withVerifiedStatuses<Row extends { remaining_amount: string | null; payment_status: string }>(rows: Row[]) {
    return rows.map(row => ({
      ...row,
      payment_status: row.remaining_amount === null ? "UNVERIFIED" as const : row.payment_status,
    }));
  }

  private static sortByField(
    field: string | undefined,
    order: string | undefined,
  ) {
    const column = {
      id: payments.id,
      payment_number: payments.payment_number,
      amount: payments.amount,
      received_at: payments.received_at,
    }[field ?? "id"];

    return (order === "asc" ? asc : desc)(column ?? payments.id);
  }

  static async createPayment(tx: any, data: PaymentInsert) {
    const [new_payment] = await tx.insert(payments).values(data).returning({
      id: payments.id,
      payment_number: payments.payment_number,
    });

    if (!new_payment) {
      throw new WorkflowError("Failed to create payment");
    }

    if (moneyToMinorUnits(data.amount) > 0n) await tx.insert(payment_receipts).values({ payment_id: new_payment.id, amount: data.amount, received_at: data.received_at ?? new Date(), kind: "receipt" });
    return new_payment;
  }

  static async getOrderTotal(orderId: number): Promise<string | null> {
    const [total_order_price] = await db
      .select({
        total: sql<string | null>`case
          when count(*) > 0 and bool_and(${order_items.unit_price_snapshot} is not null)
          then sum(${order_items.quantity} * ${order_items.unit_price_snapshot})::text
          else null
        end`,
      })
      .from(order_items)
      .where(eq(order_items.order_id, orderId));

    return total_order_price?.total ?? null;
  }

  static async updatePayment(data: PaymentUpdate) {
    if (moneyToMinorUnits(data.payment_amount) <= 0n) throw new WorkflowError("Payment amount must be positive.");
    return await db.transaction(async (tx) => {
      const [payment] = await tx
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.payment_number, data.payment_number),
            eq(payments.version, data.version),
          ),
        ).for("update");

      if (!payment) {
        throw new WorkflowError(
          `Payment with number ${data.payment_number} and version ${data.version} not found`,
        );
      }

      const [order] = await tx.select({ status: orders.status }).from(orders).where(eq(orders.id, payment.order_id));
      if (!order || order.status === "CANCELLED") throw new WorkflowError("Payments cannot be collected for a cancelled or missing order.");
      const [orderTotal] = await tx
        .select({
          total: sql<string | null>`case
            when count(*) > 0 and bool_and(${order_items.unit_price_snapshot} is not null)
            then sum(${order_items.quantity} * ${order_items.unit_price_snapshot})::text
            else null
          end`,
        })
        .from(order_items)
        .where(eq(order_items.order_id, payment.order_id));

      if (orderTotal?.total === null || orderTotal?.total === undefined) {
        throw new WorkflowError(
          "This order's historical total is unverified, so its payment cannot be updated.",
        );
      }

      const totalCostMinor = moneyToMinorUnits(orderTotal.total);
      const totalPaidMinor =
        moneyToMinorUnits(payment.amount) +
        moneyToMinorUnits(data.payment_amount);

      if (totalPaidMinor > totalCostMinor) {
        throw new WorkflowError("Payment exceeds the remaining order balance.");
      }

      const isPaid = totalPaidMinor >= totalCostMinor;
      await preserveReceiptBaseline(tx, payment);
      await tx.insert(payment_receipts).values({ payment_id: payment.id, amount: minorUnitsToMoney(moneyToMinorUnits(data.payment_amount)), received_at: new Date(), kind: "receipt" });

      const [updated_payment] = await tx
        .update(payments)
        .set({
          amount: minorUnitsToMoney(totalPaidMinor),
          payment_status: isPaid ? "PAID" : "PARTIALLY_PAID",
          received_at: new Date(),
          updated_at: new Date(),
          version: payment.version + 1,
        })
        .where(
          and(
            eq(payments.payment_number, data.payment_number),
            eq(payments.version, data.version),
          ),
        )
        .returning({
          payment_number: payments.payment_number,
        });

      if (!updated_payment) throw new WorkflowError("Payment changed. Refresh and try again.");
      return {
        payment_number: updated_payment.payment_number,
        message: `Payment ${updated_payment.payment_number} updated successfully`,
      };
    });
  }
}
