/**
 * The route template of a matched request (`/users/:id`), or `undefined` when
 * the framework has not matched one. Express: `baseUrl` + `route.path`.
 * Fastify: `routeOptions.url` (v4.10+), else the older `routerPath`.
 */
export function resolveRoute(req: any): string | undefined {
  if (!req) return undefined;
  const expressPath = req.route?.path;
  if (typeof expressPath === 'string') return `${typeof req.baseUrl === 'string' ? req.baseUrl : ''}${expressPath}`;
  const fastifyUrl = req.routeOptions?.url ?? req.routerPath;
  return typeof fastifyUrl === 'string' ? fastifyUrl : undefined;
}

export { getRootSpan } from './failure-context';
