import Elysia from "elysia";
import { DashboardService } from "./services";
import { OrderService } from "../order/service";
import { DeliveryService } from "../deliveries/service";
import { CalendarService } from "../calendar/services";

export const dashboardRoutes = new Elysia({ prefix: "/dashboard" }).get(
  "/stats",
  async ({ set }) => {
    const monthly_revenue = await DashboardService.getRevenueByMonth();
    const daily_sales = await DashboardService.getSalesByDay();
    const active_deliveries = await DashboardService.getActiveDeliveries();
    const upcoming_deliveries =
      await DashboardService.getUpcomingDeliveries();
    const delivery_calendar = await CalendarService.getDeliveryEvents();
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
);
