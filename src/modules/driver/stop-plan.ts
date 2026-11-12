import type { DriverStopPlan } from "../../db/schema/deliveries";

/** Ignore another driver's preferences and stops that already have outcomes. */
export function currentStopPlan(
  plan: DriverStopPlan | null | undefined,
  driverId: number,
  status: string,
  stops: { id: number; status: string }[],
): DriverStopPlan {
  const pending = new Set(stops.filter(s => s.status === "pending").map(s => s.id));
  const skippedStopIds = plan?.driverId === driverId && status === "in_transit"
    ? [...new Set(plan.skippedStopIds.filter(id => pending.has(id)))] : [];
  const nextStopId = plan?.driverId === driverId && status === "in_transit" &&
    plan.nextStopId !== null && pending.has(plan.nextStopId) && !skippedStopIds.includes(plan.nextStopId)
    ? plan.nextStopId : null;
  return { driverId, nextStopId, skippedStopIds };
}
