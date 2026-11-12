export class WorkflowError extends Error {
  constructor(message: string, public status = 409, public code = status === 404 ? "ASSIGNMENT_UNAVAILABLE" : status === 400 ? "INVALID_REQUEST" : status === 403 ? "ACCESS_DENIED" : "WORKFLOW_CONFLICT") { super(message); this.name = "WorkflowError"; }
}
