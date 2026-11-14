import { handleMcpRequest } from "@/lib/mcp/server";

/**
 * Model Context Protocol, Streamable HTTP transport. Stateless: every request
 * is a JSON-RPC message answered with JSON, so there's no event stream to
 * open (GET) or session to end (DELETE). Authenticated with personal API keys.
 */
export const POST = (request: Request) => handleMcpRequest(request);

const noStream = () =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "This server doesn't stream. Send JSON-RPC messages with POST." } }), {
    status: 405,
    headers: { Allow: "POST", "Content-Type": "application/json" },
  });
export const GET = noStream;
export const DELETE = noStream;
