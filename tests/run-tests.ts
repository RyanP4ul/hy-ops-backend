// Isolate route module mocks from real-service/database tests.
for (const file of ["src/utils/correctness.test.ts", "tests/report-finance.test.ts", "src/modules/user/index.test.ts", "tests/transactions.test.ts", "tests/driver.test.ts", "tests/customer-returns.test.ts", "tests/communications.test.ts", "tests/driver-features.test.ts"]) {
  const result = Bun.spawnSync([process.execPath, "test", file], { stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) process.exit(result.exitCode);
}
