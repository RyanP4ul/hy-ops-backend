import { Elysia, t } from "elysia";
import { PaymentService } from "./service";
import { AuthUser } from "../auth/schema";
import { paymentCreate } from "./model";

export const paymentRoutes = new Elysia({ prefix: "/payments" })
  .decorate("user", AuthUser)
  .use(paymentCreate)
  .get("/:number/refunds", ({ params }) => PaymentService.getRefunds(params.number), { detail: { summary: 'Get by number refunds', description: 'GET endpoint for by number refunds in the payments module.', tags: ['Payments'] } })
  .post("/refunds", async ({ body, user }) => {
    const result = await PaymentService.refund(body, Number(user.sub));
    return { ...result, payment: await PaymentService.getPaymentTableRowByNumber(result.payment_number) };
  }, {
      detail: { summary: 'Create refunds', description: 'POST endpoint for refunds in the payments module.', tags: ['Payments'] }, body: t.Object({ payment_number: t.String(), amount: t.Number({ exclusiveMinimum: 0 }), version: t.Integer({ minimum: 1 }), reason: t.String({ minLength: 1, maxLength: 500 }), request_id: t.String({ format: "uuid" }) }) })
  .get("/", async ({ query, set }) => {
    const result = await PaymentService.getPayments(
      query.page ? Number(query.page) : 0,
      query.limit ? Number(query.limit) : 10,
      query.search?.trim() ?? "",
      query.sort_by ?? "id:desc",
    );
    set.headers["X-Total-Count"] = result.total;
    return result.rows;
  }, { detail: { summary: 'List root', description: 'GET endpoint for root in the payments module.', tags: ['Payments'] } })
  .post("/", async ({ body }) => {
    const result = await PaymentService.updatePayment(body);
    const payment = await PaymentService.getPaymentTableRowByNumber(
      result.payment_number,
    );

    if (!payment) {
      throw new Error("Payment was updated but could not be loaded.");
    }

    return payment;
  }, {
      detail: { summary: 'Create root', description: 'POST endpoint for root in the payments module.', tags: ['Payments'] },
    body: "payment.update",
  });
