import { WorkflowError } from "../../utils/workflow-error";

export function assertDriverOwnership(assignedId: number | undefined, actorId: number) {
  if (assignedId !== actorId) throw new WorkflowError("Assignment not found.", 404);
}

export function assertOutcomeCommand(input: { status: string; version: number; currentVersion: number; existing?: { actor_id: number; operation_key: string; outcome: string; reason: string | null }; actorId: number; key: string; outcome: string; reason?: string }) {
  if (input.existing) {
    if (input.existing.actor_id === input.actorId && input.existing.operation_key === input.key && input.existing.outcome === input.outcome && (input.existing.reason ?? "") === (input.reason ?? "")) return "replay";
    throw new WorkflowError("This stop already has a recorded outcome. Refresh the trip.");
  }
  if (input.status !== "in_transit" || input.version !== input.currentVersion) throw new WorkflowError("Assignment changed. Refresh the trip before continuing.");
  return "apply";
}
