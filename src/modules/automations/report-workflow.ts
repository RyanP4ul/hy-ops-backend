import { DAY, dayStart, manilaDay } from "../../utils/time";
import { DEFAULT_FILTERS, REPORT_TYPES, type Filters, type ReportType } from "../analysis-reports/reports.contract";

export const REPORT_TASKS = {
  "Weekly Analysis & Reports": "weekly",
  "Monthly Analysis & Reports": "monthly",
} as const;
export type ReportCadence = "weekly" | "monthly";
export function reportCadence(name: string): ReportCadence | undefined {
  return REPORT_TASKS[name as keyof typeof REPORT_TASKS];
}
export const reportSchedule = (cadence: ReportCadence) => cadence === "weekly"
  ? "Every Monday at 06:00 (Asia/Manila)"
  : "1st of each month at 06:00 (Asia/Manila)";

function periodStart(cadence: ReportCadence, now: number) {
  const today = dayStart(manilaDay(now));
  if (cadence === "monthly") return dayStart(manilaDay(now).slice(0, 8) + "01");
  const weekday = new Date(today + 8 * 60 * 60 * 1000).getUTCDay();
  return today - ((weekday + 6) % 7) * DAY;
}

export function nextReportRun(cadence: ReportCadence, now = Date.now()): Date {
  let start = periodStart(cadence, now);
  const hour = 6 * 60 * 60 * 1000;
  if (start + hour <= now) {
    if (cadence === "weekly") start += 7 * DAY;
    else {
      const local = new Date(start + 8 * 60 * 60 * 1000);
      start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1) - 8 * 60 * 60 * 1000;
    }
  }
  return new Date(start + hour);
}

/** Last completed Monday–Sunday week or calendar month, in Manila. */
export function reportPeriod(cadence: ReportCadence, now = Date.now()) {
  const end = periodStart(cadence, now);
  const start = cadence === "weekly" ? end - 7 * DAY
    : dayStart(manilaDay(end - DAY).slice(0, 8) + "01");
  return { from: manilaDay(start), to: manilaDay(end - DAY) };
}

type Export = { body: string | Uint8Array; mime: string };
export async function generateReportArchive(cadence: ReportCadence, now: number, dependencies: {
  build: (type: ReportType, filters: Filters, now: number) => Promise<Export>;
  put: (key: string, file: Export) => Promise<void>;
}) {
  const period = reportPeriod(cadence, now);
  const filters: Filters = { ...DEFAULT_FILTERS, preset: "custom", ...period };
  const keys: string[] = [];
  for (const type of REPORT_TYPES) {
    const file = await dependencies.build(type, filters, now);
    // Stable keys allow a failed run to retry without creating duplicate archives.
    const key = `${cadence}/${period.from}_to_${period.to}/${type.toLowerCase()}-report.xlsx`;
    await dependencies.put(key, file);
    keys.push(key);
  }
  return keys;
}
