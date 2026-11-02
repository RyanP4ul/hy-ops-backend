import { Elysia } from "elysia";
import { ExportQuery, PreviewQuery } from "../reports.model";
import { parseFilters } from "../domain/filters";
import { buildExport, DEFAULT_LOW_STOCK, getPreview } from "../services/export.service";

export const exportRoutes = new Elysia({ name: "reports.export" })
  .get("/preview", ({ query }) => getPreview(query.type, parseFilters(query), query.threshold ?? DEFAULT_LOW_STOCK), {
    query: PreviewQuery,
    detail: { tags: ["Reports"], summary: "Summary and row count for the Generate Report dialog" },
  })
  .get(
    "/export",
    async ({ query }) => {
      const file = await buildExport(query.type, query.format, parseFilters(query), query.threshold ?? DEFAULT_LOW_STOCK);
      return new Response(file.body, {
        headers: { "Content-Type": file.mime, "Content-Disposition": `attachment; filename="${file.filename}"`, "Cache-Control": "no-store" },
      });
    },
    { query: ExportQuery, detail: { tags: ["Reports"], summary: "Download a report as CSV or XLSX" } },
  );
