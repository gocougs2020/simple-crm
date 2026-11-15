import "server-only";

/**
 * Whether this deployment can reach AI Gateway: an API key (local development,
 * or a deployment outside Vercel), or Vercel's OIDC token, which deployments on
 * Vercel get automatically.
 */
export const agentConfigured = () => !!(process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL);
