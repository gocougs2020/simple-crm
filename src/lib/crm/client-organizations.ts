import { sql, type SQL } from "drizzle-orm";
import { schema } from "@/db";

/**
 * A client is tied to its main organization (`clients.organization_id`) and
 * to any others kept from a merge (`client_organizations`). These say so in
 * SQL, so every place that asks "which clients does this organization have?"
 * or "who are this client's people?" counts both.
 */

const { clients } = schema;

/** Whether the client in the query (the `clients` table) is tied to `organizationId`, as its main organization or another. */
export const clientAtOrganization = (organizationId: string | SQL) =>
  sql`(${clients.organizationId} = ${organizationId} or exists (select 1 from client_organizations co where co.client_id = ${clients.id} and co.organization_id = ${organizationId}))`;

/** The ids of every organization a client is tied to, as a subquery for `in (...)`. */
export const organizationsOfClient = (clientId: string | SQL) =>
  sql`(select c.organization_id from clients c where c.id = ${clientId} and c.organization_id is not null union select co.organization_id from client_organizations co where co.client_id = ${clientId})`;
