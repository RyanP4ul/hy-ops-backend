# GitHub backup schedule

The **Settings → Database backup** tab controls one daily request to the existing `supabase-backup.yml` workflow. Time is explicitly **Asia/Manila (UTC+08:00)**, independent of the browser or server timezone. The schedule lives in the existing `automations` table; no schema migration or reseeding is required. It starts paused at 02:00.

## Deployment

1. Publish the updated `.github/workflows/supabase-backup.yml` to the repository's default branch. It keeps `workflow_dispatch` and removes the old five-minute cron. Deploy the updated workflow and backend together to avoid running both scheduling mechanisms.
2. Keep the workflow's existing Supabase and R2 repository secrets.
3. Configure these **backend-only** environment variables:

   ```env
   GITHUB_BACKUP_TOKEN=<fine-grained-token>
   GITHUB_BACKUP_REPOSITORY=<owner>/<repository>
   GITHUB_BACKUP_WORKFLOW=supabase-backup.yml
   GITHUB_BACKUP_REF=main
   ```

   Grant the token access to that repository and **Actions: read and write**. Set `GITHUB_BACKUP_REF` to the branch that should run the backup. Never add the token to frontend environment variables. See GitHub's [workflow dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event).
4. Deploy the backend and frontend. Keep the backend running with `createApp`'s `automation` option enabled (the normal server entry point already does this).
5. Open **Settings → Database backup**, select a time, enable **Automatic daily backup**, and save. **Back up now** can request a backup even while the daily schedule is paused.

## Behavior

- The backend checks every 30 seconds and dispatches a due schedule once. GitHub runner availability can delay the actual start.
- Saving an enabled schedule chooses the next occurrence strictly after the save. Pausing clears the next occurrence; it does not cancel a workflow already requested.
- After backend downtime, one overdue occurrence is requested, and the next occurrence is scheduled in the future. It does not replay every missed day.
- Database advisory transaction locks coordinate schedule edits and dispatches across replicas. Stale edits receive HTTP 409 and must be discarded/reloaded.
- A failed or uncertain GitHub request is recorded and is not automatically retried for that day's occurrence. The next daily occurrence remains scheduled; admins can inspect GitHub and request a manual retry.
- The occurrence is committed before contacting GitHub to prevent a replay after a server crash. A crash between that commit and the request can skip the occurrence; inspect GitHub and use the manual button if needed.
- “Last request attempt” records dispatch attempts, not backup completion. Workflow progress and backup success remain visible in GitHub Actions. Workflow concurrency prevents backups from running simultaneously.
- The GitHub connection status reports whether server configuration is present; token permissions and workflow availability are checked when a request is made.
- Removing the old cron means GitHub will no longer initiate scheduled backups while the backend is stopped.

## Verification

Run `bun test tests/backup-schedule.test.ts` for time conversion, dispatch contract, and access-policy checks. Run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-database.ps1 -Suite Backup` for the full suite against a newly created disposable local PostgreSQL database. GitHub requests are stubbed; tests do not request real backups.
