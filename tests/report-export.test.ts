import { beforeAll, expect, mock, test } from "bun:test";
import ExcelJS from "exceljs";
import { DEFAULT_FILTERS, REPORT_TYPES } from "../src/modules/analysis-reports/reports.contract";

mock.module("../src/modules/analysis-reports/services/datasets", () => ({
  inventoryFor: async () => [], ordersFor: async () => [], paymentsFor: async () => [], stopsFor: async () => [],
}));
let buildExport: typeof import("../src/modules/analysis-reports/services/export.service").buildExport;
beforeAll(async () => { ({ buildExport } = await import("../src/modules/analysis-reports/services/export.service.js")); });

test("each report produces a valid workbook with analysis, detail, and period metadata even without data", async () => {
  for (const type of REPORT_TYPES) {
    const file = await buildExport(type, "xlsx", { ...DEFAULT_FILTERS, preset: "custom", from: "2026-11-02", to: "2026-11-08" }, 7, Date.parse("2026-11-09T06:00:00+08:00"));
    expect(typeof file.body).not.toBe("string");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.body as ExcelJS.Buffer);
    expect(wb.getWorksheet(type)?.rowCount).toBe(1);
    expect(wb.getWorksheet("Analysis summary")?.rowCount).toBeGreaterThan(1);
    expect(wb.getWorksheet("Report details")?.getCell("B2").value).toBe("2026-11-02 to 2026-11-08");
    if (type === "Inventory") expect(String(wb.getWorksheet("Report details")?.getCell("B6").value)).toContain("Current stock snapshot");
  }
});
