export const DAY = 864e5;
export const TZ = "Asia/Manila";

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

export function isScheduledTripOverdue(
  date: string,
  time: string,
  now = Date.now(),
): boolean {
  const scheduledAt = Date.parse(toManilaIso(date, time));
  return Number.isFinite(scheduledAt) && scheduledAt < now;
}

/**
 * Several of your tables (users, vehicles, warehouses, inventory) store timestamps as
 * `integer`. A Postgres int4 cannot hold epoch *milliseconds*, so these are epoch seconds.
 */
export function nowEpochSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
