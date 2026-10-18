import { Elysia, t } from "elysia";
import { PaymentService } from "./service";

const paymentCreate = t.Object({
  payment_number: t.String({ minLength: 1, maxLength: 32 }),
  order_id: t.Numeric({ minimum: 1 }),
  customer_id: t.Numeric({ minimum: 1 }),
  payment_method: t.Union([
    t.Literal("CASH"),
    t.Literal("BANK_TRANSFER"),
    t.Literal("CARD"),
  ]),
  payment_status: t.Optional(
    t.Union([
      t.Literal("UNPAID"),
      t.Literal("PARTIALLY_PAID"),
      t.Literal("PAID"),
      t.Literal("OVERDUE"),
    ]),
  ),
  amount: t.String({ minLength: 1 }),
  reference_number: t.Optional(t.String({ maxLength: 100 })),
  received_at: t.Optional(t.String()),
});

export const paymentRoutes = new Elysia({ prefix: "/payments" }).post(
  "/",
  async ({ body }) =>
    PaymentService.createPayment({
      ...body,
      received_at: body.received_at
        ? new Date(body.received_at)
        : undefined,
    }),
  {
    body: paymentCreate,
  },
);