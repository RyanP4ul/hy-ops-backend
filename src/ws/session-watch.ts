/** Validate idle sockets too. Fail closed on a failed account lookup. */
export function watchSession(expiresAt: number, check: () => Promise<boolean>, close: (code: number, reason: string) => void, intervalMs = 5_000) {
  let stopped = false;
  let checking = false;
  const stop = () => { stopped = true; clearInterval(interval); clearTimeout(expiry); };
  const reject = (code: number, reason: string) => { if (stopped) return; stop(); close(code, reason); };
  const expiry = setTimeout(() => reject(4002, "Access token expired"), Math.max(0, expiresAt * 1000 - Date.now()));
  const interval = setInterval(async () => {
    if (stopped || checking) return;
    checking = true;
    try { if (!(await check())) reject(4001, "Session revoked"); }
    catch { reject(4003, "Unable to verify session"); }
    finally { checking = false; }
  }, intervalMs);
  return stop;
}
