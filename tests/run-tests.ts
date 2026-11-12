// Isolate route module mocks from real-service/database tests.
const automationRuntimeResult = Bun.spawnSync([process.execPath, "test", "tests/automation-runtime.test.ts"], { stdout: "inherit", stderr: "inherit" });
if (automationRuntimeResult.exitCode !== 0) process.exit(automationRuntimeResult.exitCode);
const reportAutomationResult = Bun.spawnSync([process.execPath, "test", "tests/report-automation.test.ts"], { stdout: "inherit", stderr: "inherit" });
if (reportAutomationResult.exitCode !== 0) process.exit(reportAutomationResult.exitCode);
const reportSchedulerResult = Bun.spawnSync([process.execPath, "test", "tests/report-scheduler.test.ts"], { stdout: "inherit", stderr: "inherit" });
if (reportSchedulerResult.exitCode !== 0) process.exit(reportSchedulerResult.exitCode);
const reportExportResult = Bun.spawnSync([process.execPath, "test", "tests/report-export.test.ts"], { stdout: "inherit", stderr: "inherit" });
if (reportExportResult.exitCode !== 0) process.exit(reportExportResult.exitCode);
const lalamoveResult = Bun.spawnSync([process.execPath, "test", "tests/lalamove.test.ts"], { stdout: "inherit", stderr: "inherit" });
if (lalamoveResult.exitCode !== 0) process.exit(lalamoveResult.exitCode);
const backupResult = Bun.spawnSync([process.execPath, "test", "tests/backup-schedule.test.ts"], { stdout: "inherit", stderr: "inherit" });
if (backupResult.exitCode !== 0) process.exit(backupResult.exitCode);
const paymentTypeResult = Bun.spawnSync([process.execPath, "test", "tests/payment-type.test.ts"], { stdout: "inherit", stderr: "inherit" });
if (paymentTypeResult.exitCode !== 0) process.exit(paymentTypeResult.exitCode);
for (const file of ["tests/payment-allocation.test.ts", "tests/order-batch-model.test.ts", "tests/warehouse-arrival.test.ts", "src/utils/correctness.test.ts", "tests/report-finance.test.ts", "src/modules/user/index.test.ts", "tests/transactions.test.ts", "tests/lifecycle.test.ts", "tests/archive-retention.test.ts", "tests/driver.test.ts", "tests/customer-returns.test.ts", "tests/communications.test.ts", "tests/driver-features.test.ts"]) {
  const result = Bun.spawnSync([process.execPath, "test", file], { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) process.exit(result.exitCode);
}
