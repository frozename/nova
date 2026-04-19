/**
 * Bearer-token auth helper for the facade's HTTP downstreams.
 *
 * `createBearerAuth(token)` returns a `{ fetch }` object whose `fetch`
 * stamps `Authorization: Bearer <token>` onto the outgoing request
 * and delegates to the global `fetch`. Used as the `fetch` option on
 * `StreamableHTTPClientTransport` so downstream HTTP MCP servers that
 * gate on a bearer token (sirius-mcp, etc.) are reachable without
 * leaking the token into the URL or requiring a full OAuth provider.
 *
 * The wrapper never mutates the caller's `init.headers` — it clones
 * whatever shape (Headers instance, plain object, array of pairs) was
 * passed so the original RequestInit stays untouched.
 *
 * The exported `fetch` is typed as a `FetchLike` (matching the SDK's
 * `StreamableHTTPClientTransport` `fetch` option shape) so it slots
 * into the transport without a cast. We deliberately avoid `typeof
 * fetch` for the return type because the Bun and DOM `fetch`
 * definitions disagree on a few optional members (`preconnect`,
 * Bun-only `BunFetchRequestInit`).
 */

export type FetchFn = (url: string | URL, init?: RequestInit) => Promise<Response>;

export interface BearerAuth {
  fetch: FetchFn;
}

function cloneHeadersWithAuth(
  headers: RequestInit['headers'] | undefined,
  token: string,
): Headers {
  const merged = new Headers();
  if (headers instanceof Headers) {
    headers.forEach((value, key) => merged.set(key, value));
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) merged.set(key, value);
  } else if (headers && typeof headers === 'object') {
    for (const [key, value] of Object.entries(headers as Record<string, string>)) {
      merged.set(key, value);
    }
  }
  merged.set('Authorization', `Bearer ${token}`);
  return merged;
}

export function createBearerAuth(
  token: string,
  fetchImpl: FetchFn = (url, init) => fetch(url, init),
): BearerAuth {
  const wrapped: FetchFn = (input, init) => {
    const next: RequestInit = { ...(init ?? {}) };
    next.headers = cloneHeadersWithAuth(init?.headers, token);
    return fetchImpl(input, next);
  };
  return { fetch: wrapped };
}
