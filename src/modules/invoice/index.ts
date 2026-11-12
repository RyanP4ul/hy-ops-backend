import Elysia, { t } from "elysia";
import { InvoiceService } from "./service";
import type { AuthUser } from "../auth/schema";
import { assertOrderScope, staffWarehouse } from "../deliveries/scope";

export const invoiceRoutes = new Elysia({ prefix: "/invoice" }).decorate("user", {} as AuthUser).get(
  "/:order_id",
  async ({ params, user }) => {
    await assertOrderScope(params.order_id, await staffWarehouse(user));
    return await InvoiceService.getInvoiceByOrderId(params.order_id);
  },
  {
      detail: { summary: 'Get by order id', description: 'GET endpoint for by order id in the invoices module.', tags: ['Invoices'] },
    params: t.Object({
      order_id: t.Numeric({ minimum: 1 }),
    }),
  },
);
