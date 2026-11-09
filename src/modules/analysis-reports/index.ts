import { Elysia } from "elysia";
import { customersRoutes } from "./routes/customers.routes";
import { deliveriesRoutes } from "./routes/deliveries.routes";
import { exportRoutes } from "./routes/export.routes";
import { inventoryRoutes } from "./routes/inventory.routes";
import { optionsRoutes } from "./routes/options.routes";
import { overviewRoutes } from "./routes/overview.routes";
import { paymentsRoutes } from "./routes/payments.routes";
import { salesRoutes } from "./routes/sales.routes";

/**
 * Analysis & Reports API, mounted at /api/reports.
 *
 *   GET /options                  filter dropdown choices
 *   GET /overview                 Overview tab
 *   GET /sales                    Sales tab
 *   GET /inventory                Inventory tab
 *   GET /payments                 Payments tab
 *   GET /deliveries               Deliveries tab
 *   GET /customers                Customers tab
 *   GET /customers/:id/orders     Customer drill-down
 *   GET /preview                  Generate Report dialog preview
 *   GET /export                   CSV / XLSX download
 *
 * The application mounts this module inside the authenticated role guard.
 * Reports are available to administrative and operational staff roles.
 */
export const reportsModule = new Elysia({ 
  prefix: "/reports", 
  name: "reports",
  detail: {
    tags: ["Analysis and Reports"]
  }
})
  .use(optionsRoutes)
  .use(overviewRoutes)
  .use(salesRoutes)
  .use(inventoryRoutes)
  .use(paymentsRoutes)
  .use(deliveriesRoutes)
  .use(customersRoutes)
  .use(exportRoutes);
