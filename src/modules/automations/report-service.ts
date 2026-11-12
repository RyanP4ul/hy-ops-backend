import { eq, sql } from "drizzle-orm";
import { db } from "@/db/index";
import { automations } from "@/db/schema/automation";
import { settings } from "@/db/schema";
import { WorkflowError } from "../../utils/workflow-error";
import { logger } from "../../utils/logger";
import { buildExport } from "../analysis-reports/services/export.service";
import { generateReportArchive, nextReportRun, REPORT_TASKS, reportCadence, reportSchedule } from "./report-workflow";

export async function ensureReportTasks() {
  for (const [name, cadence] of Object.entries(REPORT_TASKS)) {
    await db.insert(automations).values({
      name,
      description: "Generates sales, inventory, payment, delivery and customer Excel reports with analysis summaries and uploads them to Cloudflare R2.",
      schedule: reportSchedule(cadence),
      status: "ENABLED",
      next_run_at: nextReportRun(cadence),
      notes: `Previous completed ${cadence === "weekly" ? "Monday–Sunday week" : "calendar month"}; inventory is a current stock snapshot. R2 folder: ${cadence}/.`,
    }).onConflictDoNothing({ target: automations.name });
  }
}

export async function runReportTask(name: string, manual = false) {
  const cadence = reportCadence(name);
  if (!cadence) throw new WorkflowError("Unknown report task.", 400);
  const result = await db.transaction(async tx => {
    const lockId = cadence === "weekly" ? 72490182 : 72490183;
    const [lock] = await tx.execute(sql`select pg_try_advisory_xact_lock(${lockId}) as locked`);
    if (!lock?.locked) {
      if (manual) throw new WorkflowError("This report task is already running.", 409);
      return;
    }
    const record = await tx.query.automations.findFirst({ where: eq(automations.name, name) });
    if (!record) throw new WorkflowError("Report task not found.", 404);
    const now = Date.now();
    if (!manual && (record.status === "DISABLED" || !record.next_run_at || record.next_run_at.getTime() > now)) return;
    let error: string | null = null;
    try {
      const thresholdSetting = await db.query.settings.findFirst({ where: eq(settings.name, "low_stock_threshold") });
      const threshold = Number(thresholdSetting?.value ?? 10);
      if (!Number.isFinite(threshold) || threshold < 0) throw new Error("Invalid low-stock threshold.");
      // Lazy import keeps R2 credentials out of environments with integrations disabled.
      const [{ r2, r2Bucket }, { PutObjectCommand }] = await Promise.all([
        import("../../lib/storage/r2.js"), import("@aws-sdk/client-s3"),
      ]);
      await generateReportArchive(cadence, now, {
        build: async (type, filters, generatedAt) => {
          const file = await buildExport(type, "xlsx", filters, threshold, generatedAt);
          return { mime: file.mime, body: typeof file.body === "string" ? file.body : Buffer.from(file.body) };
        },
        put: async (key, file) => {
          await r2.send(new PutObjectCommand({
            Bucket: r2Bucket, Key: key, Body: file.body, ContentType: file.mime,
            CacheControl: "private, no-store",
          }));
        },
      });
    } catch (issue) {
      logger.error(`[Reports] ${name} failed`, issue instanceof Error ? issue.message : String(issue));
      error = "Report generation or R2 upload failed. Check server logs and retry.";
    }
    // Separate connection commits progress while the transaction holds the replica lock.
    await db.update(automations).set({
      status: record.status === "DISABLED" ? "DISABLED" : error ? "FAILED" : "ENABLED",
      last_run_at: new Date(now),
      next_run_at: record.status === "DISABLED" ? null : error ? new Date(now + 5 * 60 * 1000) : nextReportRun(cadence, now),
      last_error: error,
      updated_at: new Date(),
    }).where(eq(automations.id, record.id));
    return { error };
  });
  if (result?.error) throw new WorkflowError(result.error, 502);
  return db.query.automations.findFirst({ where: eq(automations.name, name) });
}

export async function startReportScheduler() {
  await ensureReportTasks();
  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      for (const name of Object.keys(REPORT_TASKS)) {
        try { await runReportTask(name); }
        catch (error) { logger.error("[Report scheduler]", error instanceof Error ? error.message : String(error)); }
      }
    } finally { ticking = false; }
  }
  const timer = setInterval(() => void tick(), 30000);
  timer.unref();
  void tick();
  return { stop() { clearInterval(timer); } };
}
