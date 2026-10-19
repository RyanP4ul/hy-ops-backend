import { Elysia, t } from "elysia";
import { PaymentService } from "./service";
import { paymentCreate } from "./model";

export const paymentRoutes = new Elysia({ prefix: "/payments" })
  .use(paymentCreate)
  .get("/", async ({ query, set }) => {
    const result = await PaymentService.getPayments(
      query.page ? Number(query.page) : 0,
      query.limit ? Number(query.limit) : 10,
      query.search?.trim() ?? "",
      query.sort_by ?? "id:desc",
    );
    set.headers["X-Total-Count"] = result.total;
    return result.rows;
  })
  .post("/", async ({ body }) => PaymentService.updatePayment(body), {
    body: "payment.update",
  });
