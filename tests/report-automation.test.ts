import { expect, test } from "bun:test";
import { generateReportArchive, nextReportRun, reportPeriod } from "../src/modules/automations/report-workflow";
import { rangeOf } from "../src/modules/analysis-reports/domain/filters";

test("weekly archives cover Monday through Sunday across year boundaries", () => {
  expect(reportPeriod("weekly", Date.parse("2027-01-04T06:00:00+08:00")))
    .toEqual({ from: "2026-12-28", to: "2027-01-03" });
});

test("monthly archives handle leap years and January", () => {
  expect(reportPeriod("monthly", Date.parse("2028-03-01T06:00:00+08:00")))
    .toEqual({ from: "2028-02-01", to: "2028-02-29" });
  expect(reportPeriod("monthly", Date.parse("2027-01-01T06:00:00+08:00")))
    .toEqual({ from: "2026-12-01", to: "2026-12-31" });
});

test("schedules use Manila 06:00 and advance at the exact boundary", () => {
  expect(nextReportRun("weekly", Date.parse("2026-11-08T21:59:59Z")).toISOString()).toBe("2026-11-08T22:00:00.000Z");
  expect(nextReportRun("weekly", Date.parse("2026-11-08T22:00:00Z")).toISOString()).toBe("2026-11-15T22:00:00.000Z");
  expect(nextReportRun("monthly", Date.parse("2026-12-31T22:00:00Z")).toISOString()).toBe("2027-01-31T22:00:00.000Z");
});

test("all five exports upload under the selected folder with one shared period", async () => {
  const now = Date.parse("2026-11-09T06:00:00+08:00");
  const uploads: string[] = [];
  const keys = await generateReportArchive("weekly", now, {
    async build(type, filters, generatedAt) {
      expect(filters).toMatchObject({ preset: "custom", from: "2026-11-02", to: "2026-11-08", warehouses: [], customers: [] });
      expect(rangeOf(filters, generatedAt)).toEqual({ start: Date.parse("2026-11-02T00:00:00+08:00"), end: Date.parse("2026-11-09T00:00:00+08:00") });
      return { body: type, mime: "application/test" };
    },
    async put(key, file) { expect(file.mime).toBe("application/test"); uploads.push(key); },
  });
  expect(keys).toEqual(["sales", "inventory", "payment", "delivery", "customer"].map(type => `weekly/2026-11-02_to_2026-11-08/${type}-report.xlsx`));
  expect(uploads).toEqual(keys);
});

test("failed uploads propagate and retries reuse the same monthly keys", async () => {
  const keys: string[] = [];
  const dependencies = {
    build: async () => ({ body: "xlsx", mime: "application/test" }),
    put: async (key: string) => { keys.push(key); throw new Error("R2 unavailable"); },
  };
  const now = Date.parse("2026-11-01T06:00:00+08:00");
  await expect(generateReportArchive("monthly", now, dependencies)).rejects.toThrow("R2 unavailable");
  await expect(generateReportArchive("monthly", now + 300000, dependencies)).rejects.toThrow("R2 unavailable");
  expect(keys).toEqual(Array(2).fill("monthly/2026-10-01_to_2026-10-31/sales-report.xlsx"));
});
