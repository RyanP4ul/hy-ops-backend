import type { DeliveriesResponse, Filters } from "../reports.contract";
import { deliveryMetrics, delta, groupSum } from "../domain/metrics";
import { eventsFor, stopsFor } from "./datasets";

export async function getDeliveries(f: Filters, now = Date.now()): Promise<DeliveriesResponse> {
  const [stops, prevStops, events] = await Promise.all([stopsFor(f, now), stopsFor(f, now, 1), eventsFor(f, now)]);
  const dm = deliveryMetrics(stops), pdm = deliveryMetrics(prevStops);

  return {
    kpis: {
      deliveries: dm.deliveries.length, deliveriesDelta: delta(dm.deliveries.length, pdm.deliveries.length), delivered: dm.delivered,
      failed: dm.failed, failureRate: dm.rate, avgMinutes: dm.avgMin, approvedCost: dm.cost,
    },
    byType: groupSum(dm.deliveries, (d) => d.type, () => 1),
    byVehicle: groupSum(dm.deliveries, (d) => d.vehicle, () => 1),
    byStatus: groupSum(dm.deliveries, (d) => d.status, () => 1),
    issues: events.map((e) => ({ id: e.id, date: e.delivery.date, deliveryId: e.delivery.id, vehicle: e.delivery.vehicle, driver: e.delivery.driver, type: e.type, reason: e.reason })),
  };
}
