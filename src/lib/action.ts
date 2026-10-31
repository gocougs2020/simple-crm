import "server-only";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { ActionError } from "./auth";

/** What every server action returns. The client shows `error` as-is, so it's always a sentence a person can act on. */
export type Result<T = void> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Runs an action body and turns failures into a Result. ActionErrors and
 * validation errors carry their own message; anything else is logged and
 * reported generically so internals never reach the browser.
 */
export async function run<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    unstable_rethrow(err);
    if (err instanceof ActionError) return { ok: false, error: err.message };
    if (err instanceof z.ZodError) return { ok: false, error: err.issues[0]?.message ?? "Check the highlighted fields." };
    console.error("[action]", err);
    return { ok: false, error: "Something went wrong on our side. Try again in a moment." };
  }
}

/** Parses input with a schema, throwing a readable ZodError on failure. */
export const parse = <S extends z.ZodType>(schema: S, input: unknown): z.infer<S> => schema.parse(input);
