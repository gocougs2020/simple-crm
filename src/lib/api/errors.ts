import { z } from "zod";
import { ActionError, ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";

/** The error body every API failure returns: `{ "error": { code, message, … } }`. Messages are sentences that say what to do. */
export type ApiError = {
  status: number;
  code: string;
  message: string;
  /** Validation problems, one per field. */
  issues?: { path: string; message: string }[];
  /** On 409: the record that already exists. */
  existingId?: string;
};

export class ApiFailure extends Error {
  constructor(readonly error: ApiError) {
    super(error.message);
  }
}

export function toApiError(err: unknown): ApiError | null {
  if (err instanceof ApiFailure) return err.error;
  if (err instanceof z.ZodError) {
    const issues = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    const first = issues[0];
    return { status: 422, code: "validation_error", message: first ? (first.path ? `${first.path}: ${first.message}` : first.message) : "Check the request body.", issues };
  }
  if (err instanceof NotFoundError) return { status: 404, code: "not_found", message: err.message };
  if (err instanceof ForbiddenError) return { status: 403, code: "forbidden", message: err.message };
  if (err instanceof ConflictError) {
    const cause = err.cause as { id?: string } | undefined;
    return { status: 409, code: "conflict", message: err.message, ...(cause?.id ? { existingId: cause.id } : {}) };
  }
  if (err instanceof ActionError) return { status: 400, code: "bad_request", message: err.message };
  return null;
}

export const internalError: ApiError = { status: 500, code: "internal_error", message: "Something went wrong on our side. Try again in a moment." };
