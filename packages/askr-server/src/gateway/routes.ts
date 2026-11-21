import type { GatewayRequest } from './gateway';
import { createServerLlmsTxt } from './server-llms';

export interface RouteHandlers {
  /** The server's public base, no trailing slash: the server's own llms.txt links under it. */
  publicBase: string;
  /** The admin app's files, when they are built into this server. */
  adminPages?: ((input: GatewayRequest) => Response | undefined) | undefined;
  admin: (input: GatewayRequest) => Promise<Response | undefined>;
  storeDocs: (input: GatewayRequest) => Promise<Response | undefined>;
  gateway: (input: GatewayRequest) => Promise<Response>;
}

/**
 * The server's one handler, in routing order: the admin pages, the server's own
 * `/llms.txt`, the admin API, the public store files, and the gateway for the rest.
 */
export function composeHandler(
  handlers: RouteHandlers,
): (input: GatewayRequest) => Promise<Response> {
  // A fixed file pointing agents to the store files and the docs.
  const serverLlmsTxt = createServerLlmsTxt(handlers.publicBase);
  return async (input) =>
    handlers.adminPages?.(input) ??
    serverLlmsTxt(input) ??
    (await handlers.admin(input)) ??
    (await handlers.storeDocs(input)) ??
    handlers.gateway(input);
}
