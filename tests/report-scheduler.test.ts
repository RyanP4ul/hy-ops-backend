import { beforeAll, beforeEach, expect, mock, test } from "bun:test";

let locked = true;
let fail = false;
let uploads: string[] = [];
let record: any;
const database = {
  query: {
    automations: { findFirst: async () => record },
    settings: { findFirst: async () => ({ value: "7" }) },
  },
  execute: async () => [{ locked }],
  update: () => ({ set: (values: object) => ({ where: async () => { Object.assign(record, values); } }) }),
  transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(database),
};
mock.module("../src/db/index", () => ({ db: database }));
mock.module("../src/modules/analysis-reports/services/export.service", () => ({
  buildExport: async (_type: string, format: string, _filters: unknown, threshold: number) => {
    expect(format).toBe("xlsx");
    expect(threshold).toBe(7);
    return { body: Buffer.from("workbook"), mime: "application/xlsx" };
  },
}));
mock.module("../src/lib/storage/r2.js", () => ({
  r2Bucket: "fixture-bucket",
  r2: { send: async (command: any) => {
    if (fail) throw new Error("Upload failed");
    expect(command.input.Bucket).toBe("fixture-bucket");
    uploads.push(command.input.Key);
  } },
}));
let runReportTask: typeof import("../src/modules/automations/report-service").runReportTask;
beforeAll(async () => { ({ runReportTask } = await import("../src/modules/automations/report-service.js")); });

beforeEach(() => {
  locked = true; fail = false; uploads = [];
  record = { id: 1, name: "Weekly Analysis & Reports", status: "ENABLED", next_run_at: new Date(0), last_run_at: null, last_error: null };
});

test("a persisted due task uploads five reports and advances its schedule", async () => {
  await runReportTask(record.name);
  expect(uploads).toHaveLength(5);
  expect(record.status).toBe("ENABLED");
  expect(record.last_run_at).toBeInstanceOf(Date);
  expect(record.next_run_at.getTime()).toBeGreaterThan(Date.now());
  await runReportTask(record.name);
  expect(uploads).toHaveLength(5);
});

test("disabled and future tasks do not run automatically", async () => {
  record.status = "DISABLED";
  await runReportTask(record.name);
  record.status = "ENABLED";
  record.next_run_at = new Date(Date.now() + 60000);
  await runReportTask(record.name);
  expect(uploads).toHaveLength(0);
});

test("manual execution preserves a disabled task", async () => {
  record.status = "DISABLED";
  await runReportTask(record.name, true);
  expect(uploads).toHaveLength(5);
  expect(record.status).toBe("DISABLED");
  expect(record.next_run_at).toBeNull();
});

test("upload failure stays failed, reports an error, and schedules a retry", async () => {
  fail = true;
  await expect(runReportTask(record.name, true)).rejects.toThrow("R2 upload failed");
  expect(record.status).toBe("FAILED");
  expect(record.last_error).toContain("R2 upload failed");
  expect(record.next_run_at.getTime() - record.last_run_at.getTime()).toBe(300000);
  fail = false;
  await runReportTask(record.name, true);
  expect(record.status).toBe("ENABLED");
  expect(record.last_error).toBeNull();
});

test("a replica lock prevents overlapping runs", async () => {
  locked = false;
  await runReportTask(record.name);
  await expect(runReportTask(record.name, true)).rejects.toThrow("already running");
  expect(uploads).toHaveLength(0);
});
