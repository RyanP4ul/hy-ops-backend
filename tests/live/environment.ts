export function fixtureEnvironment() {
  const target = process.env.HYOPS_TEST_DATABASE_URL;
  if (!target) throw new Error("Run through scripts/test-database.ps1 -Suite Live.");
  const url = new URL(target);
  if (url.hostname !== "127.0.0.1" || url.pathname !== "/hyops_test" || url.username !== "hyops_test") throw new Error("Refusing a non-fixture database.");
  // Do not inherit integration secrets loaded automatically by Bun from .env.
  for (const key of Object.keys(process.env)) {
    if (/^(DATABASE|JWT|REFRESH_TOKEN|R2_|GOOGLE_|AWS_|LALAMOVE|SMS|SEMAPHORE|DEBUG_SQL)/.test(key)) delete process.env[key];
  }
  Object.assign(process.env, {
    DATABASE_URL: target, NODE_ENV: "test", DEBUG_SQL: "false",
    JWT_SECRET: "local-fixture-access-key-never-for-deployment",
    REFRESH_TOKEN_SECRET: "local-fixture-refresh-key-never-for-deployment",
    APP_ORIGINS: "http://127.0.0.1:3100",
    R2_ACCOUNT_ID: "fixture", R2_ACCESS_KEY_ID: "fixture", R2_SECRET_ACCESS_KEY: "fixture", R2_BUCKET_NAME: "fixture",
    GOOGLE_CLIENT_ID: "fixture", GOOGLE_CLIENT_SECRET: "fixture", GOOGLE_REFRESH_TOKEN: "fixture", GOOGLE_REDIRECT_URI: "http://127.0.0.1:5180/disabled",
    LALAMOVE_API_KEY: "fixture", LALAMOVE_API_SECRET: "fixture",
  });
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== "127.0.0.1") throw new Error("External network disabled in live fixture.");
    return nativeFetch(input, init);
  }, { preconnect: nativeFetch.preconnect }) as typeof fetch;
  return target;
}
