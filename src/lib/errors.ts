/**
 * Errors meant for people. The server action wrapper shows the message as-is;
 * the REST API and MCP map each class to a status code. Kept free of server
 * imports so pure modules (and tests) can use them.
 */
export class ActionError extends Error {}
/** The record doesn't exist (or was deleted). HTTP 404. */
export class NotFoundError extends ActionError {}
/** The caller's role or key doesn't allow this. HTTP 403. */
export class ForbiddenError extends ActionError {}
/** It clashes with something that already exists (a duplicate email). HTTP 409. */
export class ConflictError extends ActionError {}
