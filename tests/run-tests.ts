// Isolate route module mocks from real-service/database tests.
const paymentTypeResult = Bun.spawnSync([process.execPath, "test", "tests/payment-type.test.ts"], { stdout: "inherit", stderr: "inherit" });
if (paymentTypeResult.exitCode !== 0) process.exit(paymentTypeResult.exitCode);
for (const file of ["tests/warehouse-arrival.test.ts", "src/utils/correctness.test.ts", "tests/report-finance.test.ts", "src/modules/user/index.test.ts", "tests/transactions.test.ts", "tests/driver.test.ts", "tests/customer-returns.test.ts", "tests/communications.test.ts", "tests/driver-features.test.ts"]) {
  const result = Bun.spawnSync([process.execPath, "test", file], { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) process.exit(result.exitCode);
}
