import { and, eq, sql } from "drizzle-orm";
import type { db } from "../../db";
import { users } from "../../db/schema/users";
import { WorkflowError } from "../../utils/workflow-error";

export type MutationActor = { id: number; tokenVersion: number };
type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class UserMutationError extends WorkflowError {
  constructor(message: string, public status: 401 | 403 | 409 = 409) {
    super(message, status);
    this.name = "UserMutationError";
  }
}

export async function lockUserMutation(tx: Transaction, actor: MutationActor) {
  // Serialize account administration before reading permissions. Two admins
  // cannot simultaneously remove each other's access using stale role checks.
  await tx.execute(sql`select pg_advisory_xact_lock(721001)`);
  const [current] = await tx.select().from(users)
    .where(and(eq(users.id, actor.id), eq(users.is_archived, false)))
    .for("update");
  if (!current || current.token_version !== actor.tokenVersion) {
    throw new UserMutationError("Your session is no longer valid. Sign in again.", 401);
  }
  if (current.role !== "admin") {
    throw new UserMutationError("Only administrators can manage user accounts.", 403);
  }
}

export function assertOtherAccount(actorId: number, targetId: number) {
  if (actorId === targetId) {
    throw new UserMutationError("You cannot remove your own administrator access.", 403);
  }
}
