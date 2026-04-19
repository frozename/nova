import { describe, expect, test } from 'bun:test';
import { createBearerAuth, type FetchFn } from '../src/facade/auth.js';

/**
 * Covers the bearer-token wrapper at `src/facade/auth.ts`.
 *  - stamps `Authorization: Bearer <token>` on the three header
 *    shapes a caller might pass (Headers instance, plain object,
 *    array of pairs)
 *  - does not mutate the caller's headers object
 */

interface Recorded {
  url: string | URL;
  init: RequestInit | undefined;
}

function makeRecorder(): { fetch: FetchFn; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const fetchImpl: FetchFn = async (input, init) => {
    calls.push({ url: input, init });
    return new Response('ok', { status: 200 });
  };
  return { fetch: fetchImpl, calls };
}

function getAuthHeader(init: RequestInit | undefined): string | null {
  if (!init?.headers) return null;
  const h = init.headers;
  if (h instanceof Headers) return h.get('Authorization');
  return null;
}

describe('facade/auth createBearerAuth', () => {
  test('stamps Authorization header when caller passes Headers instance', async () => {
    const rec = makeRecorder();
    const caller = new Headers({ 'X-Other': 'keep' });
    const { fetch: wrapped } = createBearerAuth('tok', rec.fetch);
    await wrapped('http://example.test/', { headers: caller });
    const recorded = rec.calls[0]!;
    expect(getAuthHeader(recorded.init)).toBe('Bearer tok');
    const h = recorded.init!.headers as Headers;
    expect(h.get('X-Other')).toBe('keep');
    // caller's Headers object was not mutated
    expect(caller.get('Authorization')).toBeNull();
  });

  test('stamps Authorization header when caller passes plain object', async () => {
    const rec = makeRecorder();
    const caller: Record<string, string> = { 'X-Other': 'keep' };
    const { fetch: wrapped } = createBearerAuth('tok', rec.fetch);
    await wrapped('http://example.test/', { headers: caller });
    expect(getAuthHeader(rec.calls[0]!.init)).toBe('Bearer tok');
    // caller's plain-object was not mutated
    expect('Authorization' in caller).toBe(false);
    expect(caller['X-Other']).toBe('keep');
  });

  test('stamps Authorization header when caller passes array of pairs', async () => {
    const rec = makeRecorder();
    const caller: Array<[string, string]> = [['X-Other', 'keep']];
    const { fetch: wrapped } = createBearerAuth('tok', rec.fetch);
    await wrapped('http://example.test/', { headers: caller });
    expect(getAuthHeader(rec.calls[0]!.init)).toBe('Bearer tok');
    // caller's array was not mutated (still length 1 with the original entry)
    expect(caller).toEqual([['X-Other', 'keep']]);
  });

  test('works when caller passes no init at all', async () => {
    const rec = makeRecorder();
    const { fetch: wrapped } = createBearerAuth('tok', rec.fetch);
    await wrapped('http://example.test/');
    expect(getAuthHeader(rec.calls[0]!.init)).toBe('Bearer tok');
  });
});
