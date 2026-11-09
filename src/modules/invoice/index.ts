import Elysia, { t } from "elysia";
import { InvoiceService } from "./service";

export const invoiceRoutes = new Elysia({ prefix: "/invoice" }).get(
  "/:order_id",
  async ({ params }) => {
    return await InvoiceService.getInvoiceByOrderId(params.order_id);
  },
  {
      detail: { summary: 'Get by order id', description: 'GET endpoint for by order id in the invoices module.', tags: ['Invoices'] },
    params: t.Object({
      order_id: t.Numeric({ minimum: 1 }),
    }),
  },
);
