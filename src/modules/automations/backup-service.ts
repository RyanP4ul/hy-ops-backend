import { eq, sql } from "drizzle-orm";
import { db } from "@/db/index";
import { automations } from "@/db/schema/automation";
import { WorkflowError } from "../../utils/workflow-error";
import { logger } from "../../utils/logger";
import { BACKUP_NAME, BACKUP_TIMEZONE, backupConnection, dispatchBackup, nextBackupRun } from "./backup-workflow";

// A transaction-scoped lock coordinates edits and dispatches across server replicas.
const LOCK_ID = 72490181;
let schedulerRunning = false;

async function ensureBackup() {
  await db.insert(automations).values({
    name: BACKUP_NAME,
    description: "Requests the Supabase database backup workflow on GitHub Actions.",
    schedule: "Daily at 02:00 (Asia/Manila)",
    daily_time: "02:00",
    interval_ms: null,
    status: "DISABLED",
  }).onConflictDoNothing({ target: automations.name });
}

export abstract class BackupService {
  static async get() {
    await ensureBackup();
    const record = await db.query.automations.findFirst({ where: eq(automations.name, BACKUP_NAME) });
    if (!record) throw new WorkflowError("Backup schedule not found.", 404);
    const config = backupConnection();
    return {
      enabled: record.status !== "DISABLED",
      daily_time: record.daily_time ?? "02:00",
      timezone: BACKUP_TIMEZONE,
      next_run_at: record.next_run_at,
      last_requested_at: record.last_run_at,
      last_error: record.last_error,
      updated_at: record.updated_at,
      configured: config.configured,
      scheduler_running: schedulerRunning,
      workflow_url: config.configured ? `https://github.com/${config.repository}/actions/workflows/${encodeURIComponent(config.workflow)}` : null,
    };
  }

  static async save(data: { enabled: boolean; daily_time: string; updated_at: string }) {
    const next = nextBackupRun(data.daily_time);
    if (data.enabled && !backupConnection().configured) throw new WorkflowError("Configure the GitHub backup connection on the server before enabling automatic backups.", 503);
    await ensureBackup();
    await db.transaction(async tx => {
      const [lock] = await tx.execute(sql`select pg_try_advisory_xact_lock(${LOCK_ID}) as locked`);
      if (!lock?.locked) throw new WorkflowError("A backup request is in progress. Try again shortly.", 409);
      const current = await tx.query.automations.findFirst({ where: eq(automations.name, BACKUP_NAME) });
      if (!current || current.updated_at.toISOString() !== data.updated_at) throw new WorkflowError("This schedule changed. Reload it before saving.", 409);
      await tx.update(automations).set({
        daily_time: data.daily_time,
        schedule: `Daily at ${data.daily_time} (${BACKUP_TIMEZONE})`,
        interval_ms: null,
        status: data.enabled ? "ENABLED" : "DISABLED",
        next_run_at: data.enabled ? next : null,
        updated_at: new Date(Math.max(Date.now(), current.updated_at.getTime() + 1)),
      }).where(eq(automations.name, BACKUP_NAME));
    });
    return this.get();
  }

  static async run(manual = false) {
    await ensureBackup();
    const result = await db.transaction(async tx => {
      const [lock] = await tx.execute(sql`select pg_try_advisory_xact_lock(${LOCK_ID}) as locked`);
      if (!lock?.locked) {
        if (manual) throw new WorkflowError("A backup request is already in progress.", 409);
        return { requested: false };
      }
      const record = await tx.query.automations.findFirst({ where: eq(automations.name, BACKUP_NAME) });
      if (!record) throw new WorkflowError("Backup schedule not found.", 404);
      const now = new Date();
      if (!manual && (record.status === "DISABLED" || !record.next_run_at || record.next_run_at > now)) return { requested: false };
      // The advisory-lock transaction only holds the lock. Commit the occurrence
      // using a separate pooled connection BEFORE contacting GitHub, so a process
      // crash after GitHub accepts it cannot replay this scheduled occurrence.
      await db.update(automations).set({
        last_run_at: now,
        next_run_at: record.status === "DISABLED" ? null : manual ? record.next_run_at : nextBackupRun(record.daily_time ?? "02:00", now),
        last_error: null,
        updated_at: new Date(Math.max(Date.now(), record.updated_at.getTime() + 1)),
      }).where(eq(automations.name, BACKUP_NAME));
      let error: string | null = null;
      try { await dispatchBackup(); }
      catch (issue) { error = issue instanceof WorkflowError ? issue.message : "Unable to request the backup workflow."; }
      // Do not roll back the durable occurrence on an uncertain network failure.
      await db.update(automations).set({
        status: record.status === "DISABLED" ? "DISABLED" : error ? "FAILED" : "ENABLED",
        last_error: error,
        updated_at: sql`greatest(now(), ${automations.updated_at} + interval '1 millisecond')`,
      }).where(eq(automations.name, BACKUP_NAME));
      return { requested: !error, error };
    });
    if (result.error) throw new WorkflowError(result.error, 502);
    return result;
  }
}

export async function startBackupScheduler() {
  await ensureBackup();
  // Persisted next_run_at survives restarts; an overdue schedule is requested once.
  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try { await BackupService.run(); }
    catch (error) { logger.error("[Backup scheduler]", error instanceof Error ? error.message : "Backup request failed"); }
    finally { ticking = false; }
  }
  schedulerRunning = true;
  const timer = setInterval(() => void tick(), 30000);
  timer.unref();
  void tick();
  return { stop() { clearInterval(timer); schedulerRunning = false; } };
}
