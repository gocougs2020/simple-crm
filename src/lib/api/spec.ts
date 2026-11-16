import { z } from "zod";
import { datetime } from "@/lib/crm/schemas";
import type { Permission } from "@/lib/permissions";
import type { ModelName } from "./models";

/**
 * One API operation, described once. The REST router, the OpenAPI document,
 * the docs page and the MCP tool list are all generated from these, so they
 * can't drift apart. Pure (no server imports) so tests and the static docs
 * page can read it.
 */
export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";
/** Parts of the API a deployment turns on with its own configuration. Their MCP and assistant tools only appear where they're set up. */
export type OptionalFeature = "knowledge";
type Obj = z.ZodObject;

export type Operation<P extends Obj | undefined = Obj | undefined, Q extends Obj | undefined = Obj | undefined, B extends Obj | undefined = Obj | undefined> = {
  method: HttpMethod;
  /** OpenAPI-style path under /api/v1, like /people/{id}. */
  path: string;
  tag: string;
  summary: string;
  description?: string;
  permission: Permission;
  params?: P;
  query?: Q;
  body?: B;
  /** The model in `data`; with `list`, `data` is an array of it and `nextCursor` pages through. */
  response: ModelName;
  list?: boolean;
  status?: 200 | 201;
  /** The MCP tool name, or null to leave it out of MCP. */
  tool: string | null;
  /** A longer description for agents, when the summary isn't enough. */
  toolDescription?: string;
  /** A request body for the docs' example. Generated from the schema when left out. */
  example?: Record<string, unknown>;
  /** Only offered as a tool where this feature is set up (the REST endpoint explains how when it isn't). */
  feature?: OptionalFeature;
};

export const op = <P extends Obj | undefined = undefined, Q extends Obj | undefined = undefined, B extends Obj | undefined = undefined>(o: Operation<P, Q, B>) => o;

type Out<S> = S extends z.ZodType ? z.output<S> : Record<string, never>;
export type InputOf<O> = O extends Operation<infer P, infer Q, infer B> ? { params: Out<P>; query: Out<Q>; body: Out<B> } : never;

// ─── Shared parameters ───────────────────────────────────────────────────

/** Query strings carry text; these accept real booleans and numbers too, so MCP tools can pass them as JSON. */
export const queryBool = z.preprocess((v) => (v === "true" || v === "1" ? true : v === "false" || v === "0" ? false : v), z.boolean());
export const queryInt = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

export const idParam = z.object({ id: z.uuid().describe("The record's id.") });
export const pageQuery = {
  limit: queryInt(1, 100).optional().describe("How many to return, 1–100. Defaults to 50."),
  cursor: z.string().max(200).optional().describe("nextCursor from the previous page."),
};
export const recordQuery = {
  q: z.string().trim().max(100).optional().describe("Search text."),
  ownerId: z.string().max(40).optional().describe('A teammate id, "me" for the key\'s own teammate, or "none" for unowned.'),
  updatedSince: datetime.optional().describe("Only records changed at or after this time (ISO 8601). For syncing."),
  includeArchived: queryBool.optional().describe("Include archived records. Defaults to false."),
  ...pageQuery,
};
