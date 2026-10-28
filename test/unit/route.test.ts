import { describe, expect, it } from 'vitest';
import { resolveRoute } from '../../src/http/route';

describe('resolveRoute', () => {
  it('express route with baseUrl', () =>
    expect(resolveRoute({ baseUrl: '/api', route: { path: '/users/:id' } })).toBe('/api/users/:id'));
  it('express route without baseUrl', () => expect(resolveRoute({ route: { path: '/users/:id' } })).toBe('/users/:id'));
  it('fastify route', () => expect(resolveRoute({ routeOptions: { url: '/users/:id' } })).toBe('/users/:id'));
  it('fastify legacy routerPath', () => expect(resolveRoute({ routerPath: '/users/:id' })).toBe('/users/:id'));
  it('unknown → undefined', () => expect(resolveRoute({})).toBeUndefined());
  it('null request → undefined', () => expect(resolveRoute(undefined)).toBeUndefined());
});
