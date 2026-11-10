param([string]$TestNamePattern = "walk-in|scheduling combobox|cancelled delivery retains|concurrent final stops", [switch]$Browser)
$ErrorActionPreference = 'Stop'
$backendRoot = Split-Path -Parent $PSScriptRoot
$pgBin = Split-Path -Parent (Get-Command psql.exe -ErrorAction Stop).Source
$fixtureBase = Join-Path (Split-Path -Parent $backendRoot) '.local-test-pg'
New-Item -ItemType Directory -Force -Path $fixtureBase | Out-Null
$fixtureRoot = Join-Path $fixtureBase ('walk-in-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixtureRoot | Out-Null
$fixturePort = Get-Random -Minimum 55000 -Maximum 60000
$oldTestUrl = $env:HYOPS_TEST_DATABASE_URL
$started = $false
Push-Location $backendRoot
try {
  & (Join-Path $pgBin 'initdb.exe') -D $fixtureRoot -U hyops_test -A trust --no-locale -E UTF8
  if ($LASTEXITCODE -ne 0) { throw 'Fixture initialization failed.' }
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
  # Test the actual upgrade against the previous schema and a historical counter sale.
  $upgradePath = Join-Path $fixtureRoot 'upgrade.sql'
  @'
ALTER TABLE orders DROP CONSTRAINT orders_sales_channel_valid;
ALTER TABLE orders DROP COLUMN sales_channel, DROP COLUMN walk_in_checkout_key, DROP COLUMN walk_in_checkout_fingerprint, DROP COLUMN walk_in_amount_tendered;
INSERT INTO users (email,name,password_hash,role,created_at,updated_at) VALUES ('historical@example.test','Historical','fixture','customer',0,0);
INSERT INTO customers (user_id,company_name,phone_number) VALUES (1,'Historical','09171234567');
INSERT INTO warehouses (name,street_address,city,state,zip_code,created_at,updated_at) VALUES ('Historical','Street','City','Province','0000',0,0);
INSERT INTO orders (order_number,warehouse_id,customer_id,delivery_method,status) VALUES ('HISTORICAL',1,1,'WALK_IN','COMPLETED');
'@ | Set-Content -Encoding UTF8 -LiteralPath $upgradePath
  & (Join-Path $pgBin 'psql.exe') -h 127.0.0.1 -p $fixturePort -U hyops_test -d hyops_test -v ON_ERROR_STOP=1 -f $upgradePath
  if ($LASTEXITCODE -ne 0) { throw 'Upgrade fixture setup failed.' }
  & (Join-Path $pgBin 'psql.exe') -h 127.0.0.1 -p $fixturePort -U hyops_test -d hyops_test -v ON_ERROR_STOP=1 -f ./src/db/migrations/0001_walk_in_vehicle_delivery.sql
  if ($LASTEXITCODE -ne 0) { throw 'Walk-in migration failed.' }
  $assertPath = Join-Path $fixtureRoot 'assert-upgrade.sql'
  @'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM orders WHERE order_number='HISTORICAL' AND sales_channel='WALK_IN' AND status='COMPLETED') THEN
    RAISE EXCEPTION 'Historical counter sale was not preserved';
  END IF;
END $$;
'@ | Set-Content -Encoding UTF8 -LiteralPath $assertPath
  & (Join-Path $pgBin 'psql.exe') -h 127.0.0.1 -p $fixturePort -U hyops_test -d hyops_test -v ON_ERROR_STOP=1 -f $assertPath
  if ($LASTEXITCODE -ne 0) { throw 'Historical backfill failed.' }
  $env:HYOPS_TEST_DATABASE_URL = "postgres://hyops_test@127.0.0.1:$fixturePort/hyops_test"
  & bun test --timeout 30000 ./tests/transactions.test.ts --test-name-pattern $TestNamePattern
  if ($LASTEXITCODE -ne 0) { throw 'Walk-in integration tests failed.' }
  if ($Browser) {
    & (Join-Path $pgBin 'psql.exe') -h 127.0.0.1 -p $fixturePort -U hyops_test -d hyops_test -v ON_ERROR_STOP=1 -c 'TRUNCATE users,warehouses,products,settings RESTART IDENTITY CASCADE'
    if ($LASTEXITCODE -ne 0) { throw 'Browser fixture reset failed.' }
    & bun run tests/live/runner.ts Orders 'Walk-in vehicle delivery'
    if ($LASTEXITCODE -ne 0) { throw 'Walk-in browser tests failed.' }
  }
} finally {
  $env:HYOPS_TEST_DATABASE_URL = $oldTestUrl
  if ($started -and !$fixtureServer.HasExited) {
    & (Join-Path $pgBin 'pg_ctl.exe') -D $fixtureRoot -m immediate stop | Out-Null
    if ($LASTEXITCODE -ne 0 -and !$fixtureServer.HasExited) { Stop-Process -Id $fixtureServer.Id }
  }
  Pop-Location
}
