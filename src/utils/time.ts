export const DAY = 864e5;
export const TZ = "Asia/Manila";
export const DEPARTURE_GRACE_MINUTES = 60;
export const RETURN_GRACE_MINUTES = 60;
export const DRIVER_START_EARLY_WINDOW_MINUTES = 60;

export const manilaDay = (d: Date | number) =>
  new Date(d).toLocaleDateString("en-CA", { timeZone: TZ });
export const dayStart = (day: string) =>
  new Date(`${day}T00:00:00+08:00`).getTime();

/** Today's calendar date in Manila as YYYY-MM-DD (matches the `date` columns). */
export function todayInManila(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** Combine a `date` + `time` column into an ISO string (Manila has no DST: always +08:00). */
export function toManilaIso(date: string, time: string): string {
  const normalized = time.length === 5 ? `${time}:00` : time;
  return `${date}T${normalized}+08:00`;
}

/**
 * A scheduled trip becomes overdue only after the departure grace window
 * (at least 1 hour past the scheduled departure time) has elapsed.
 */
export function isScheduledTripOverdue(
  date: string,
  time: string,
  now = Date.now(),
  graceMinutes = DEPARTURE_GRACE_MINUTES,
): boolean {
  const scheduledAt = Date.parse(toManilaIso(date, time));
  if (!Number.isFinite(scheduledAt)) return false;
  const effectiveGraceMs = Math.max(0, graceMinutes) * 60_000;
  return scheduledAt + effectiveGraceMs < now;
}

/**
 * Drivers can start a trip within a flexible window starting up to 1 hour
 * before scheduled departure and lasting through the scheduled Manila day
 * (or at least 1 hour past departure for late-evening trips).
 */
export function canDriverStartTripAt(
  date: string,
  time: string,
  now = Date.now(),
  earlyMinutes = DRIVER_START_EARLY_WINDOW_MINUTES,
  lateGraceMinutes = DEPARTURE_GRACE_MINUTES,
): boolean {
  const scheduledAt = Date.parse(toManilaIso(date, time));
  if (!Number.isFinite(scheduledAt)) return false;
  const earliestMs = scheduledAt - Math.max(0, earlyMinutes) * 60_000;
  const endOfScheduledDayMs = dayStart(date) + DAY - 1;
  const latestMs = Math.max(
    endOfScheduledDayMs,
    scheduledAt + Math.max(0, lateGraceMinutes) * 60_000,
  );
  return now >= earliestMs && now <= latestMs;
}

/**
 * Several of your tables (users, vehicles, warehouses, inventory) store timestamps as
 * `integer`. A Postgres int4 cannot hold epoch *milliseconds*, so these are epoch seconds.
 */
export function nowEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
