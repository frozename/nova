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

/** Normalize any of the three `HeadersInit` shapes (Headers instance,
 *  array of pairs, plain object) into a flat list of `[key, value]`
 *  pairs, dropping any pair with an undefined member. */
function headerEntries(headers: RequestInit["headers"] | undefined): [string, string][] {
  if (headers instanceof Headers) {
    return [...headers.entries()];
  }
  if (Array.isArray(headers)) {
    const pairs: [string, string][] = [];
    for (const [key, value] of headers) {
      if (key !== undefined && value !== undefined) pairs.push([key, value]);
    }
    return pairs;
  }
  if (headers && typeof headers === "object") {
    return Object.entries(headers as Record<string, string>);
  }
  return [];
}

function cloneHeadersWithAuth(headers: RequestInit["headers"] | undefined, token: string): Headers {
  const merged = new Headers();
  for (const [key, value] of headerEntries(headers)) merged.set(key, value);
  merged.set("Authorization", `Bearer ${token}`);
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
