import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { backupConnection, dispatchBackup, nextBackupRun, BACKUP_NAME } from "../src/modules/automations/backup-workflow";
import { mayAccess } from "../src/modules/auth/policy";

test("daily backup time uses Manila independently of browser/server timezone and rolls past midnight", () => {
  expect(nextBackupRun("02:00", new Date("2026-11-05T17:59:00Z")).toISOString()).toBe("2026-11-05T18:00:00.000Z");
  expect(nextBackupRun("02:00", new Date("2026-11-05T18:00:00Z")).toISOString()).toBe("2026-11-06T18:00:00.000Z");
  expect(nextBackupRun("00:00", new Date("2026-12-31T15:59:59Z")).toISOString()).toBe("2026-12-31T16:00:00.000Z");
  expect(nextBackupRun("23:59", new Date("2026-12-31T16:00:00Z")).toISOString()).toBe("2027-01-01T15:59:00.000Z");
  for (const time of ["24:00", "1:00", "12:60", "", "09:00:00"]) expect(() => nextBackupRun(time)).toThrow("valid daily backup time");
});

test("GitHub dispatch uses server credentials and a branch ref without exposing upstream errors or retrying", async () => {
  const config = backupConnection({ GITHUB_BACKUP_TOKEN: "fixture-secret", GITHUB_BACKUP_REPOSITORY: "fixture/backend", GITHUB_BACKUP_REF: "production" });
  const calls: { url: string; init?: RequestInit }[] = [];
  const transport = (async (url: string, init?: RequestInit) => { calls.push({ url, init }); return new Response(null, { status: 204 }); }) as unknown as typeof fetch;
  await dispatchBackup(transport, config);
  expect(calls[0].url).toBe("https://api.github.com/repos/fixture/backend/actions/workflows/supabase-backup.yml/dispatches");
  expect(JSON.parse(String(calls[0].init?.body))).toEqual({ ref: "production" });
  expect(new Headers(calls[0].init?.headers).get("authorization")).toBe("Bearer fixture-secret");
  let attempts = 0;
  const rejected = (async () => { attempts++; return new Response("fixture-secret must never leak", { status: 403 }); }) as unknown as typeof fetch;
  await expect(dispatchBackup(rejected, config)).rejects.toThrow("Actions write permission");
  expect(attempts).toBe(1);
  const unknown = (async () => { throw new Error("fixture-secret"); }) as unknown as typeof fetch;
  await expect(dispatchBackup(unknown, config)).rejects.toThrow("Check GitHub Actions before retrying");
  await expect(dispatchBackup(transport, backupConnection({}))).rejects.toThrow("not been configured");
  expect(calls).toHaveLength(1);
});

test("backup endpoints remain admin-only", () => {
  for (const path of ["/automations/backup-schedule", "/automations/backup-schedule/run"]) {
    for (const method of ["GET", "PUT", "POST"]) {
      expect(mayAccess("admin", method, path)).toBe(true);
      for (const role of ["staff", "driver", "customer"]) expect(mayAccess(role, method, path)).toBe(false);
    }
  }
});

const testUrl = process.env.HYOPS_TEST_DATABASE_URL;
let sql: import("postgres").Sql;
let service: typeof import("../src/modules/automations/backup-service").BackupService;
let generic: typeof import("../src/modules/automations/service").AutomationService;
const originalFetch = globalThis.fetch;
const originalEnv = Object.fromEntries(["GITHUB_BACKUP_TOKEN", "GITHUB_BACKUP_REPOSITORY", "GITHUB_BACKUP_REF"].map(key => [key, process.env[key]]));
let attempts = 0, mode = "ok", durableClaimObserved = false;

async function expectRejection(operation: Promise<unknown>, message: string) {
  // Await database rejections directly, allowing transactions to finish before assertions.
  let error: unknown;
  try { await operation; } catch (issue) { error = issue; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain(message);
}

describe.skipIf(!testUrl)("backup schedule in disposable PostgreSQL", () => {
  beforeAll(async () => {
    const target = new URL(testUrl ?? "");
    if (target.hostname !== "127.0.0.1" || target.pathname !== "/hyops_test" || target.username !== "hyops_test") throw new Error("Use the disposable loopback hyops_test fixture.");
    process.env.DATABASE_URL = testUrl;
    sql = require("postgres").default(testUrl, { onnotice: () => {} });
    ({ BackupService: service } = require("../src/modules/automations/backup-service"));
    ({ AutomationService: generic } = require("../src/modules/automations/service"));
    globalThis.fetch = (async (input: string) => {
      if (!String(input).startsWith("https://api.github.com/repos/fixture/backend/")) throw new Error("External networking is blocked by the backup fixture");
      attempts++;
      if (mode === "slow") {
        const [claim] = await sql`select next_run_at, last_run_at from automations where name=${BACKUP_NAME}`;
        durableClaimObserved = claim.next_run_at > new Date() && claim.last_run_at instanceof Date;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (mode === "unknown") throw new Error("fixture-secret must never leak");
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
  });
  beforeEach(async () => {
    Object.assign(process.env, { GITHUB_BACKUP_TOKEN: "fixture-secret", GITHUB_BACKUP_REPOSITORY: "fixture/backend", GITHUB_BACKUP_REF: "main" });
    mode = "ok"; attempts = 0; durableClaimObserved = false;
    await sql`delete from automations where name=${BACKUP_NAME}`;
  });
  afterAll(async () => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await sql?.end();
    await require("../src/db/index").db.$client.end({ timeout: 1 });
  });

  test("starts paused, saves a real schedule, rejects stale edits and supports pausing", async () => {
    const initial = await service.get();
    expect(initial).toMatchObject({ enabled: false, daily_time: "02:00", timezone: "Asia/Manila", next_run_at: null, configured: true });
    expect(JSON.stringify(initial)).not.toContain("fixture-secret");
    const saved = await service.save({ enabled: true, daily_time: "23:15", updated_at: initial.updated_at.toISOString() });
    expect(saved.enabled).toBe(true);
    expect(saved.next_run_at?.getTime()).toBeGreaterThan(Date.now());
    expect(saved.next_run_at?.getUTCHours()).toBe(15);
    expect(saved.next_run_at?.getUTCMinutes()).toBe(15);
    await expectRejection(service.save({ enabled: true, daily_time: "12:00", updated_at: initial.updated_at.toISOString() }), "schedule changed");
    const paused = await service.save({ enabled: false, daily_time: "23:15", updated_at: saved.updated_at.toISOString() });
    expect(paused.next_run_at).toBeNull();
    expect(await service.run()).toEqual({ requested: false });
    expect(attempts).toBe(0);
  });

  test("only one replica dispatches an overdue occurrence and catch-up schedules the next future day", async () => {
    await service.get();
    await sql`update automations set status='ENABLED', daily_time='23:15', next_run_at=now()-interval '3 days' where name=${BACKUP_NAME}`;
    mode = "slow";
    const results = await Promise.all([service.run(), service.run()]);
    expect(results.filter(result => result.requested)).toHaveLength(1);
    expect(durableClaimObserved).toBe(true);
    expect(attempts).toBe(1);
    const saved = await service.get();
    expect(saved.next_run_at?.getTime()).toBeGreaterThan(Date.now());
    await service.run();
    expect(attempts).toBe(1);
  });

  test("manual request works while paused and preserves an enabled schedule", async () => {
    await service.get();
    expect(await service.run(true)).toMatchObject({ requested: true });
    expect((await service.get()).next_run_at).toBeNull();
    const initial = await service.get();
    const saved = await service.save({ enabled: true, daily_time: "10:30", updated_at: initial.updated_at.toISOString() });
    await service.run(true);
    expect((await service.get()).next_run_at?.toISOString()).toBe(saved.next_run_at?.toISOString());
    expect(attempts).toBe(2);
  });

  test("uncertain dispatch is recorded, never retried automatically, and can be retried manually", async () => {
    await service.get();
    await sql`update automations set status='ENABLED', next_run_at=now()-interval '1 hour' where name=${BACKUP_NAME}`;
    mode = "unknown";
    await expectRejection(service.run(), "Check GitHub Actions before retrying");
    const saved = await service.get();
    expect(saved.last_error).not.toContain("fixture-secret");
    expect(saved.last_error).toContain("Unable to confirm");
    expect(saved.next_run_at?.getTime()).toBeGreaterThan(Date.now());
    await service.run();
    expect(attempts).toBe(1);
    mode = "ok";
    await service.run(true);
    expect((await service.get()).last_error).toBeNull();
  });

  test("missing connection allows paused preferences but prevents enabling and generic edits", async () => {
    delete process.env.GITHUB_BACKUP_TOKEN;
    const initial = await service.get();
    expect(initial.configured).toBe(false);
    await expectRejection(service.save({ enabled: true, daily_time: "08:00", updated_at: initial.updated_at.toISOString() }), "Configure the GitHub");
    const saved = await service.save({ enabled: false, daily_time: "08:00", updated_at: initial.updated_at.toISOString() });
    expect(saved.daily_time).toBe("08:00");
    const [record] = await sql`select id from automations where name=${BACKUP_NAME}`;
    await expectRejection(generic.update(record.id, { name: "Renamed" }), "GitHub backup schedule controls");
    await expectRejection(generic.setEnabled(record.id, true), "GitHub backup schedule controls");
    await expectRejection(generic.create({ name: BACKUP_NAME, description: "Duplicate", schedule: "daily" }), "GitHub backup schedule controls");
    expect(attempts).toBe(0);
  });
});
