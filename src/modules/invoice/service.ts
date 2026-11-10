import { getOrderCombinedPayment } from "../payments/groups";
import { db } from "@/db/index";
import { invoice_payments, invoices } from "@/db/schema/invoice";
import { inventory } from "@/db/schema/inventory";
import { order_items, orders } from "@/db/schema/order";
import { product_variants, products } from "@/db/schema/products";
import { payments } from "@/db/schema/payment";
import { customers, users } from "@/db/schema/users";
import { eq, sql } from "drizzle-orm";
import { minorUnitsToMoney, moneyToMinorUnits } from "../../utils/money";

export abstract class InvoiceService {
  static async getInvoiceByOrderId(order_id: number) {
    const [invoice] = await db
      .select({
        id: invoices.id,
        invoice_number: invoices.invoice_number,
        order_id: invoices.order_id,
        customer_id: invoices.customer_id,
        status: invoices.status,
        issue_date: invoices.issue_date,
        order_status: orders.status,
        order_notes: orders.notes,
        delivery_method: orders.delivery_method,
        sales_channel: orders.sales_channel,
        shipping_recipient: orders.shipping_recipient,
        shipping_phone: orders.shipping_phone,
        payment_arrangement: orders.payment_arrangement,
        customer_name: users.name,
        customer_email: sql<string | null>`nullif(${users.email}, 'walkin@system.local')`,
        company_name: customers.company_name,
        phone_number: customers.phone_number,
        payment_method: invoice_payments.payment_method,
        payment_type: sql<string | null>`(select ${payments.payment_type} from ${payments} where ${payments.order_id} = ${invoices.order_id} order by ${payments.id} limit 1)`,
        full_address: orders.shipping_address,
      })
      .from(invoices)
      .leftJoin(orders, eq(invoices.order_id, orders.id))
      .leftJoin(customers, eq(invoices.customer_id, customers.id))
      .leftJoin(users, eq(customers.user_id, users.id))
      .leftJoin(invoice_payments, eq(invoices.id, invoice_payments.invoice_id))
      .where(eq(invoices.order_id, order_id))
      .limit(1);

    if (!invoice) {
      throw new Error(`Invoice not found for order_id: ${order_id}`);
    }

    const items = await db
      .select({
        id: order_items.id,
        name: products.name,
        variant_name: product_variants.name,
        description: product_variants.description,
        quantity: order_items.quantity,
        unit_price: order_items.unit_price_snapshot,
      })
      .from(order_items)
      .leftJoin(inventory, eq(order_items.inventory_id, inventory.id))
      .leftJoin(products, eq(inventory.product_id, products.id))
      .leftJoin(
        product_variants,
        eq(inventory.product_variant_id, product_variants.id),
      )
      .where(eq(order_items.order_id, order_id));

    const [paymentSummary] = await db
      .select({
        amount_paid: sql<string>`coalesce(sum(${payments.amount}), 0)`,
      })
      .from(payments)
      .where(eq(payments.order_id, order_id));

    const amountPaid = Number(paymentSummary?.amount_paid ?? 0);
    const total = items.some((item) => item.unit_price === null)
      ? null
      : Number(
          minorUnitsToMoney(
            items.reduce(
              (sum, item) =>
                sum +
                moneyToMinorUnits(item.unit_price ?? "0") *
                  BigInt(item.quantity),
              0n,
            ),
          ),
        );
    const paymentStatus =
      total === null
        ? "UNVERIFIED"
        : amountPaid <= 0
          ? "UNPAID"
          : amountPaid >= total
            ? "PAID"
            : "PARTIALLY_PAID";
    const issueDate = invoice.issue_date || new Date();
    const dueDate = new Date(issueDate);
    if (invoice.payment_arrangement === "NET_30") {
      dueDate.setDate(dueDate.getDate() + 30);
    }

    const isWalkIn = invoice.sales_channel === "WALK_IN";

    return {
      invoice_number: invoice.invoice_number,
      status: invoice.status,
      issue_date: issueDate.toISOString().slice(0, 10),
      due_date: dueDate.toISOString().slice(0, 10),
      payment_arrangement: invoice.payment_arrangement,
      payment_method: invoice.payment_method,
      payment_type: invoice.payment_type,
      payment_status: paymentStatus,
      amount_paid: amountPaid,
      delivery_type: invoice.delivery_method,
      sales_channel: invoice.sales_channel,
      combined_payment: await getOrderCombinedPayment(order_id),
      customer: {
        name:
          isWalkIn && invoice.shipping_recipient?.trim()
            ? invoice.shipping_recipient.trim()
            : invoice.customer_name,
        company_name: isWalkIn && invoice.customer_email === null ? undefined : invoice.company_name,
        address: invoice.full_address,
        email: invoice.customer_email,
        phone:
          isWalkIn && invoice.shipping_phone?.trim()
            ? invoice.shipping_phone.trim()
            : invoice.phone_number,
      },
      items: items.map((item) => ({
        id: item.id,
        name: item.name ?? item.variant_name ?? "Item",
        description: item.description ?? item.variant_name ?? undefined,
        quantity: item.quantity,
        unit_price:
          item.unit_price === null ? null : Number(item.unit_price),
      })),
      discount: 0,
      tax: 0,
      other_charges: 0,
      notes: invoice.order_notes ?? undefined,
    };
  }

  static async createInvoice(
    tx: any,
    order_id: number,
    customer_id: number,
    payment_method: string,
    items: { inventory_id: number; quantity: number }[],
  ) {
    const [invoice] = await tx
      .insert(invoices)
      .values({
        invoice_number: `INV-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        order_id,
        customer_id,
        status: "DRAFT",
      })
      .returning({
        id: invoices.id,
      });

    if (!invoice) {
      throw new Error("Failed to create invoice");
    }

    const invoice_payment = await tx.insert(invoice_payments).values({
      invoice_id: invoice.id,
      payment_method: payment_method,
      payment_details: "None",
    });

    if (!invoice_payment) {
      throw new Error("Failed to create invoice payment");
    }

    return true;
  }
}
