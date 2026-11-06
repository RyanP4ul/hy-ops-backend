import { WorkflowError } from "../../utils/workflow-error";

export const BACKUP_NAME = "Supabase Database Backup";
export const BACKUP_TIMEZONE = "Asia/Manila";
export const DAILY_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Philippine time has a fixed UTC+08:00 offset and no daylight saving. */
export function nextBackupRun(time: string, now = new Date()) {
  if (!DAILY_TIME.test(time)) throw new WorkflowError("Choose a valid daily backup time.", 400);
  const local = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const [hour, minute] = time.split(":").map(Number);
  let next = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour - 8, minute);
  if (next <= now.getTime()) next += 24 * 60 * 60 * 1000;
  return new Date(next);
}

export function backupConnection(env: Record<string, string | undefined> = process.env) {
  const repository = env.GITHUB_BACKUP_REPOSITORY?.trim() ?? "";
  const token = env.GITHUB_BACKUP_TOKEN?.trim() ?? "";
  const workflow = env.GITHUB_BACKUP_WORKFLOW?.trim() || "supabase-backup.yml";
  const ref = env.GITHUB_BACKUP_REF?.trim() || "main";
  const configured = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository)
    && Boolean(token) && /^[a-zA-Z0-9_.-]+\.ya?ml$/.test(workflow);
  return { repository, token, workflow, ref, configured };
}

export async function dispatchBackup(
  transport: typeof fetch = fetch,
  config = backupConnection(),
) {
  if (!config.configured) throw new WorkflowError("The GitHub backup connection has not been configured on the server.", 503);
  let response: Response;
  try {
    response = await transport(`https://api.github.com/repos/${config.repository}/actions/workflows/${encodeURIComponent(config.workflow)}/dispatches`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${config.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "HyOps-Backup-Scheduler",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ref: config.ref }),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
  } catch {
    // Do not automatically retry an ambiguous dispatch: GitHub may have accepted it.
    throw new WorkflowError("Unable to confirm the backup request. Check GitHub Actions before retrying.", 502);
  }
  if (!response.ok) {
    const message = response.status === 401 || response.status === 403
      ? "GitHub rejected the backup credentials. Check the server token’s Actions write permission."
      : response.status === 404
        ? "GitHub could not find the backup workflow. Check the repository, workflow file, and token access."
        : "GitHub did not accept the backup request. Check GitHub Actions before retrying.";
    throw new WorkflowError(message, 502);
  }
}
