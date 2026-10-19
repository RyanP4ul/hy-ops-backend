import Elysia, { t, Static } from "elysia";

export const payment_update = t.Object({
  payment_number: t.String({ minLength: 1, maxLength: 32 }),
  payment_amount: t.Number({ minimum: 0 }),
  version: t.Number({ minimum: 0 }),
});

export type PaymentUpdate = Static<typeof payment_update>;

export const paymentCreate = new Elysia().model({
  "payment.update": payment_update,
});
