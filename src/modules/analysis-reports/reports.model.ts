// Request validation (Elysia / TypeBox). Responses are typed by reports.contract.ts.
import { t } from "elysia";
import { DATE_PRESETS, EXPORT_FORMATS, REPORT_TYPES } from "./reports.contract";

const day = t.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const list = t.Optional(t.String({ maxLength: 2000 })); // comma-separated values, e.g. customers=1,4,7

/** Shared by every report endpoint. Array filters are sent comma-separated; parseFilters() validates the values. */
export const FiltersQuery = t.Object({
  preset: t.Optional(t.Union(DATE_PRESETS.map((p) => t.Literal(p)))),
  from: t.Optional(day),
  to: t.Optional(day),
  customers: list, products: list, warehouses: list, arrangements: list, payStatuses: list, orderStatuses: list,
  deliveryStatuses: list, deliveryTypes: list, vehicles: list, paymentMethods: list,
  overdueOnly: t.Optional(t.Union([t.Literal("true"), t.Literal("false")])),
});

const reportType = t.Union(REPORT_TYPES.map((r) => t.Literal(r)));

/** Preview: the filters plus which report. `threshold` is the low-stock threshold chosen in the UI. */
export const PreviewQuery = t.Object({ ...FiltersQuery.properties, type: reportType, threshold: t.Optional(t.Numeric({ minimum: 0 })) });

export const ExportQuery = t.Object({
  ...PreviewQuery.properties,
  format: t.Union(EXPORT_FORMATS.map((x) => t.Literal(x))),
});

export const CustomerParams = t.Object({ id: t.Numeric() });
