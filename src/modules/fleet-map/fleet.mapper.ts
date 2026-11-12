import { isScheduledTripOverdue, toManilaIso } from "../../utils/time";
import { currentStopPlan } from "../driver/stop-plan";
import { toWarehouseDto } from "../warehouse/mapper";
import type {
  DeliveryRow,
  OrderItemRow,
  PaymentRow,
  StopRow,
  VehicleRow,
  WarehouseRow,
} from "./fleet.repository";
import type {
  FleetOverviewDto,
  OrderDto,
  StopDto,
  TripDto,
  VehicleDto,
} from "./fleet.model";

export interface FleetRawData {
  warehouses: WarehouseRow[];
  vehicles: VehicleRow[];
  deliveries: DeliveryRow[];
  stops: StopRow[];
  items: OrderItemRow[];
  payments: PaymentRow[];
}

// The schema has no color column; a stable palette keeps each vehicle's color across reloads.
const VEHICLE_COLORS = [
  "#2563eb",
  "#16a34a",
  "#dc2626",
  "#9333ea",
  "#ea580c",
  "#0891b2",
  "#ca8a04",
  "#db2777",
];

const NET_TERMS_DAYS = 30;
const round2 = (value: number) => Math.round(value * 100) / 100;

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = map.get(k);
    if (bucket) bucket.push(row);
    else map.set(k, [row]);
  }
  return map;
}

function tripLabel(departureTime: string): string {
  const hour = Number(departureTime.slice(0, 2));
  if (hour < 12) return "Morning run";
  if (hour < 17) return "Afternoon run";
  return "Evening run";
}

function dueDateFor(createdAt: Date): string {
  const due = new Date(createdAt);
  due.setUTCDate(due.getUTCDate() + NET_TERMS_DAYS);
  return due.toISOString().slice(0, 10);
}

function buildOrder(
  row: StopRow,
  itemsByOrder: Map<number, OrderItemRow[]>,
  paymentsByOrder: Map<number, PaymentRow[]>,
): OrderDto {
  const { order, customer, customerUserName } = row;

  const items = (itemsByOrder.get(order.id) ?? []).map((item) => ({
    id: String(item.id),
    name:
      item.variantName === item.productName
        ? item.productName
        : `${item.productName} – ${item.variantName}`,
    quantity: item.quantity,
    unitPrice: item.price === null ? null : Number(item.price),
  }));

  const totalAmount = items.some((item) => item.unitPrice === null)
    ? null
    : round2(
        items.reduce(
          (sum, item) => sum + item.quantity * (item.unitPrice ?? 0),
          0,
        ),
      );

  // Payments are ordered newest-first by the repository.
  const orderPayments = paymentsByOrder.get(order.id) ?? [];
  const amountPaid = round2(
    orderPayments
      .filter((p) => p.status === "PAID" || p.status === "PARTIALLY_PAID")
      .reduce((sum, p) => sum + Number(p.amount), 0),
  );

  const paymentArrangement = order.payment_arrangement ?? "NET_30";

  return {
    id: order.order_number,
    customer: {
      // customers.company_name defaults to the literal string "none"
      name:
        customer.company_name && customer.company_name !== "none"
          ? customer.company_name
          : customerUserName,
      code: `CUS-${String(customer.id).padStart(4, "0")}`,
      phone: customer.phone_number,
    },
    paymentArrangement,
    paymentMethod: orderPayments[0]?.method ?? null,
    paymentType: orderPayments[0]?.type ?? null,
    totalAmount,
    amountPaid,
    dueDate:
      paymentArrangement === "NET_30"
        ? dueDateFor(order.created_at)
        : undefined,
    items,
  };
}

function buildStop(
  row: StopRow,
  itemsByOrder: Map<number, OrderItemRow[]>,
  paymentsByOrder: Map<number, PaymentRow[]>,
): StopDto {
  const order = buildOrder(row, itemsByOrder, paymentsByOrder);
  return {
    id: String(row.stop.id),
    name: row.order.shipping_recipient?.trim() || order.customer.name,
    address: row.order.shipping_address?.trim() || "No address on file",
    coordinates: [Number(row.stop.longitude), Number(row.stop.latitude)],
    // The UI has two states. A failed stop has been visited, so it counts as done.
    status: row.stop.status === "pending" ? "pending" : "completed",
    order,
  };
}

export function buildFleetOverview(raw: FleetRawData): FleetOverviewDto {
  const itemsByOrder = groupBy(raw.items, (item) => item.orderId);
  const paymentsByOrder = groupBy(raw.payments, (p) => p.orderId);
  const stopsByDelivery = groupBy(raw.stops, (row) => row.stop.delivery_id);
  const deliveriesByVehicle = groupBy(
    raw.deliveries,
    (row) => row.delivery.vehicle_id,
  );

  const stopsOf = (deliveryId: number): StopDto[] =>
    (stopsByDelivery.get(deliveryId) ?? []).map((row) =>
      buildStop(row, itemsByOrder, paymentsByOrder),
    );

  const vehicles: VehicleDto[] = raw.vehicles.map((vehicle) => {
    // Already sorted by date/time ascending by the repository.
    const mine = deliveriesByVehicle.get(vehicle.id) ?? [];

    const active = mine.find(
      (d) =>
        d.delivery.status === "in_transit" || d.delivery.status === "returning",
    );
    const lastFinished = active
      ? undefined
      : [...mine].reverse().find((d) => d.delivery.status === "completed");
    const current = active ?? lastFinished;
    const upcoming = mine.filter((d) => d.delivery.status === "scheduled");

    const stops = current ? stopsOf(current.delivery.id) : [];
    if (current) {
      const run = current.delivery;
      const plan = currentStopPlan(run.driver_stop_plan, run.driver_id, run.status,
        (stopsByDelivery.get(run.id) ?? []).map(row => row.stop));
      for (const stop of stops) {
        stop.skippedForNow = plan.skippedStopIds.includes(Number(stop.id));
        stop.deliverNext = plan.nextStopId === Number(stop.id);
      }
    }
    const completedStops = stops.filter((s) => s.status === "completed").length;
    const allDone = stops.length > 0 && completedStops === stops.length;

    let status: VehicleDto["status"] = "available";
    if (active) {
      status =
        active.delivery.status === "returning" || allDone
          ? "returning"
          : "delivering";
    }

    const blockedReason =
      !active && vehicle.status !== "available" ? vehicle.status : undefined;

    const scheduledTrips: TripDto[] = upcoming.map((d) => {
      const { scheduled_date, departure_time } = d.delivery;
      return {
        id: String(d.delivery.id),
        label: tripLabel(departure_time),
        scheduledAt: toManilaIso(scheduled_date, departure_time),
        phase: isScheduledTripOverdue(scheduled_date, departure_time)
          ? "overdue"
          : "upcoming",
        stops: stopsOf(d.delivery.id),
      };
    });

    return {
      id: String(vehicle.id),
      driver: current?.driverName ?? upcoming[0]?.driverName ?? "Unassigned",
      plate: vehicle.plate_number,
      color:
        VEHICLE_COLORS[vehicle.id % VEHICLE_COLORS.length] ??
        VEHICLE_COLORS[0],
      warehouseId: String(vehicle.warehouse_id),
      trip: current
        ? {
            id: String(current.delivery.id),
            label: tripLabel(current.delivery.departure_time),
            scheduledAt: toManilaIso(
              current.delivery.scheduled_date,
              current.delivery.departure_time,
            ),
          }
        : null,
      stops,
      scheduledTrips,
      // There is no GPS table, so position is derived from stop progress and animated
      // client-side. Resume at the start of the next unfinished leg.
      legIndex:
        status === "delivering"
          ? completedStops
          : status === "returning"
            ? stops.length
            : 0,
      progress: 0,
      completedStops,
      status,
      blockedReason,
      speed: status === "available" ? 0 : 35,
    };
  });

  const warehouses = raw.warehouses.flatMap((row) => {
    const dto = toWarehouseDto(row);
    return dto ? [dto] : [];
  });

  return { vehicles, warehouses };
}
