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
.get("/exceptions", async ({ user }) => {
  const warehouseId = await staffWarehouse(user);
  const [operations, stock] = await Promise.all([
    DashboardService.getExceptions(warehouseId),
    InventoryService.getSummary(warehouseId ?? null),
  ]);
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
  async ({ user }) => {
    const warehouseId = await staffWarehouse(user);
    const [
      monthly_revenue,
      daily_sales,
      active_deliveries,
      upcoming_deliveries,
      delivery_calendar,
      top_selling_products,
      top_customers,
      total_orders,
      total_active_deliveries,
      total_pending,
    ] = await Promise.all([
      DashboardService.getRevenueByMonth(warehouseId),
      DashboardService.getSalesByDay(warehouseId),
      DashboardService.getActiveDeliveries(warehouseId),
      DashboardService.getUpcomingDeliveries(warehouseId),
      DashboardService.getDeliveryCalendar(warehouseId),
      DashboardService.getTopSellingProducts(warehouseId),
      DashboardService.getTopCustomers(warehouseId),
      OrderService.getTotalOrders(warehouseId),
      DeliveryService.getTotalActiveDeliveries(warehouseId),
      OrderService.getTotalPendingOrders(warehouseId),
    ]);

    return {
      revenue: monthly_revenue[monthly_revenue.length - 1]?.revenue ?? 0,
      monthly_revenue,
      daily_sales,
      active_deliveries,
      upcoming_deliveries,
      delivery_calendar,
      top_selling_products,
      top_customers,
      total_orders,
      total_active_deliveries,
      total_pending,
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
