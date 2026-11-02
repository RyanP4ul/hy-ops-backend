param([ValidateSet('Database', 'Driver', 'Live', 'Mobile')][string]$Suite = 'Database', [ValidateSet('All', 'Selected', 'DashboardReports', 'Orders', 'Deliveries', 'UIUX', 'Operations', 'Authorization', 'Driver')][string]$BrowserScope = 'All', [string]$BrowserFilter = '')
$ErrorActionPreference = 'Stop'
$backendRoot = Split-Path -Parent $PSScriptRoot
$pgBin = Split-Path -Parent (Get-Command psql.exe -ErrorAction Stop).Source
$fixtureBase = Join-Path (Split-Path -Parent $backendRoot) '.local-test-pg'
New-Item -ItemType Directory -Force -Path $fixtureBase | Out-Null
$fixtureRoot = Join-Path $fixtureBase ('hyops-fixture-' + [guid]::NewGuid().ToString('N'))
$fixturePort = Get-Random -Minimum 55000 -Maximum 60000
$oldTestUrl = $env:HYOPS_TEST_DATABASE_URL
$started = $false
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
Push-Location $backendRoot
try {
  & (Join-Path $pgBin 'initdb.exe') -D $fixtureRoot -U hyops_test -A trust --no-locale -E UTF8
  if ($LASTEXITCODE -ne 0) { throw 'Fixture initialization failed.' }
  # Direct startup also works inside an already-restricted Windows token;
  # pg_ctl's extra restricted-token creation can fail there (Windows error 87).
  $fixtureServer = Start-Process -FilePath (Join-Path $pgBin 'postgres.exe') -ArgumentList @('-D', ('"' + $fixtureRoot + '"'), '-p', "$fixturePort", '-h', '127.0.0.1') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $fixtureRoot 'server.stdout.log') -RedirectStandardError (Join-Path $fixtureRoot 'server.log')
  $started = $true
  $ready = $false
  for ($attempt = 0; $attempt -lt 50; $attempt++) {
    & (Join-Path $pgBin 'pg_isready.exe') -h 127.0.0.1 -p $fixturePort -U hyops_test -d postgres *> $null
    if ($LASTEXITCODE -eq 0) { $ready = $true; break }
    Start-Sleep -Milliseconds 200
  }
  if (!$ready) { throw 'Fixture server failed to start.' }
  & (Join-Path $pgBin 'createdb.exe') -h 127.0.0.1 -p $fixturePort -U hyops_test hyops_test
  if ($LASTEXITCODE -ne 0) { throw 'Fixture database creation failed.' }
  $schemaPath = Join-Path $fixtureRoot 'schema.sql'
  & bun --bun node_modules/drizzle-kit/bin.cjs export --dialect postgresql --schema ./src/db/schema/index.ts --sql | Set-Content -Encoding UTF8 -LiteralPath $schemaPath
  if ($LASTEXITCODE -ne 0) { throw 'Schema export failed.' }
  & (Join-Path $pgBin 'psql.exe') -h 127.0.0.1 -p $fixturePort -U hyops_test -d hyops_test -v ON_ERROR_STOP=1 -f $schemaPath
  if ($LASTEXITCODE -ne 0) { throw 'Fixture schema creation failed.' }
  # Reconstruct only the columns/tables changed by the five incremental migrations.
  # The target is always the new, empty loopback fixture created above.
  $legacyPath = Join-Path $fixtureRoot 'legacy-columns.sql'
  @'
DROP TABLE customer_returns;
DROP TABLE driver_stop_proofs;
DROP TABLE driver_stop_outcomes;
DROP TABLE vehicle_positions;
DROP TABLE payment_receipts;
DROP TABLE payment_refunds;
DROP TABLE stock_movements;
ALTER TABLE payments DROP COLUMN refunded_amount;
ALTER TABLE orders DROP COLUMN shipping_latitude, DROP COLUMN shipping_longitude, DROP COLUMN shipping_address_source_id;
ALTER TABLE payments ALTER COLUMN received_at SET DEFAULT now();
ALTER TABLE payments ALTER COLUMN received_at SET NOT NULL;
ALTER TABLE order_items DROP COLUMN unit_price_snapshot;
ALTER TABLE order_items DROP COLUMN price_source;
ALTER TABLE orders DROP COLUMN stock_reserved;
ALTER TABLE orders DROP CONSTRAINT orders_warehouse_id_warehouses_id_fk;
ALTER TABLE orders ADD CONSTRAINT orders_warehouse_id_users_id_fk FOREIGN KEY (warehouse_id) REFERENCES users(id);
'@ | Set-Content -Encoding UTF8 -LiteralPath $legacyPath
  & (Join-Path $pgBin 'psql.exe') -h 127.0.0.1 -p $fixturePort -U hyops_test -d hyops_test -v ON_ERROR_STOP=1 -f $legacyPath
  if ($LASTEXITCODE -ne 0) { throw 'Legacy fixture column setup failed.' }
  foreach ($migration in @('0000_nullable_payment_received_at.sql', '0001_order_item_price_snapshots.sql', '0002_order_stock_reservations.sql', '0003_destinations_stock_history_refunds.sql', '0004_gps_and_receipt_events.sql', '0006_driver_stop_outcomes.sql', '0007_driver_history_proofs.sql', '0008_customer_return_pickups.sql')) {
    & (Join-Path $pgBin 'psql.exe') -h 127.0.0.1 -p $fixturePort -U hyops_test -d hyops_test -v ON_ERROR_STOP=1 -f (Join-Path $backendRoot "src/db/migrations/$migration")
    if ($LASTEXITCODE -ne 0) { throw "Fixture migration failed: $migration" }
  }
  $env:HYOPS_TEST_DATABASE_URL = "postgres://hyops_test@127.0.0.1:$fixturePort/hyops_test"
  if ($Suite -eq 'Mobile') { & bun run ./tests/mobile/runner.ts }
  elseif ($Suite -eq 'Live') { & bun run ./tests/live/runner.ts $BrowserScope $BrowserFilter }
  elseif ($Suite -eq 'Driver') {
    & bun test --timeout 60000 ./tests/driver.test.ts
    if ($LASTEXITCODE -ne 0) { throw 'Driver API tests failed.' }
    & bun test --timeout 30000 ./tests/communications.test.ts
    if ($LASTEXITCODE -ne 0) { throw 'Communications API tests failed.' }
    & bun test --timeout 30000 ./tests/customer-returns.test.ts
    if ($LASTEXITCODE -ne 0) { throw 'Customer return tests failed.' }
    & bun test --timeout 30000 ./tests/driver-features.test.ts
    if ($LASTEXITCODE -ne 0) { throw 'Driver feature tests failed.' }
    & bun test --timeout 30000 ./tests/driver-socket.test.ts
  }
  else {
    & bun test --timeout 30000 ./tests/transactions.test.ts
    if ($LASTEXITCODE -ne 0) { throw 'Existing transaction tests failed.' }
    & bun test --timeout 30000 ./tests/driver.test.ts
    if ($LASTEXITCODE -ne 0) { throw 'Driver API tests failed.' }
    & bun test --timeout 30000 ./tests/communications.test.ts
    if ($LASTEXITCODE -ne 0) { throw 'Communications API tests failed.' }
    & bun test --timeout 30000 ./tests/customer-returns.test.ts
    if ($LASTEXITCODE -ne 0) { throw 'Customer return tests failed.' }
    & bun test --timeout 30000 ./tests/driver-features.test.ts
    if ($LASTEXITCODE -ne 0) { throw 'Driver feature tests failed.' }
    & bun test --timeout 30000 ./tests/driver-socket.test.ts
  }
  if ($LASTEXITCODE -ne 0) { throw "$Suite tests failed." }
} finally {
  if ($started) { & (Join-Path $pgBin 'pg_ctl.exe') -D $fixtureRoot -m fast -w stop }
  $env:HYOPS_TEST_DATABASE_URL = $oldTestUrl
  Pop-Location
  Write-Output "Stopped fixture; diagnostic files retained at $fixtureRoot"
}
