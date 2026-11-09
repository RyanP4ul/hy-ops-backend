import Elysia from "elysia";
import { AuthUser } from "../auth/schema";
import { staffWarehouse } from "../deliveries/scope";
import { DashboardService } from "./services";
import { OrderService } from "../order/service";
import { DeliveryService } from "../deliveries/service";
import { InventoryService } from "../inventory/service";

export const dashboardRoutes = new Elysia({
  prefix: "/dashboard",
  detail: { tags: ["Dashboard"] },
})
.decorate("user", {} as AuthUser)
.get("/exceptions", async () => {
  const [operations, stock] = await Promise.all([DashboardService.getExceptions(), InventoryService.getSummary()]);
  return { ...operations, lowStock: stock.low, outOfStock: stock.out };
}, {
  detail: {
    summary: "Get dashboard exceptions",
    description: "Retrieve operational exceptions and inventory shortages.",
    tags: ["Dashboard"],
  },
})
.get(
  "/stats",
  async ({ set, user }) => {
    const monthly_revenue = await DashboardService.getRevenueByMonth();
    const daily_sales = await DashboardService.getSalesByDay();
    const active_deliveries = await DashboardService.getActiveDeliveries();
    const upcoming_deliveries =
      await DashboardService.getUpcomingDeliveries();
    const delivery_calendar = await DashboardService.getDeliveryCalendar(await staffWarehouse(user));
    const top_selling_products =
      await DashboardService.getTopSellingProducts();
    const top_customers = await DashboardService.getTopCustomers();
    const total_orders = await OrderService.getTotalOrders();
    const total_active_deliveries =
      await DeliveryService.getTotalActiveDeliveries();
    const total_pending = await OrderService.getTotalPendingOrders();

    return {
      revenue: monthly_revenue[monthly_revenue.length - 1]?.revenue ?? 0,
      monthly_revenue,
      daily_sales,
      active_deliveries,
      upcoming_deliveries,
      delivery_calendar,
      top_selling_products,
      top_customers,
      total_orders: total_orders,
      total_active_deliveries: total_active_deliveries,
      total_pending: total_pending,
    };
  },
  {
    detail: {
      summary: "Get dashboard statistics",
      description: "Retrieve dashboard revenue, sales, delivery, order, and customer statistics.",
      tags: ["Dashboard"],
    },
  },
);
