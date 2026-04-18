import { describe, expect, test } from 'bun:test';
import {
  ModelInfoSchema,
  ProviderHealthSchema,
  UnifiedAiRequestSchema,
  UnifiedAiResponseSchema,
  UnifiedEmbeddingRequestSchema,
  UnifiedStreamEventSchema,
  type AiProvider,
  type UnifiedAiRequest,
  type UnifiedAiResponse,
} from '../src/index.js';

/**
 * Round-trip each schema through zod parse + a well-formed payload.
 * The tests are the reference examples downstream consumers (sirius,
 * embersynth, llamactl) can crib from when adopting Nova types.
 */

describe('nova chat schemas', () => {
  test('accepts a minimal chat request', () => {
    const req: UnifiedAiRequest = {
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    };
    expect(UnifiedAiRequestSchema.parse(req)).toEqual(req);
  });

  test('accepts tools + response_format + providerOptions + capabilities', () => {
    const req: UnifiedAiRequest = {
      model: 'claude-3-5-sonnet',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'reason step by step' },
      ],
      tools: [
        {
          type: 'function',
          function: { name: 'lookup', parameters: { type: 'object' } },
        },
      ],
      tool_choice: 'auto',
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'Answer', schema: {} },
      },
      capabilities: ['reasoning', 'tools'],
      providerOptions: { top_k: 40 },
    };
    expect(() => UnifiedAiRequestSchema.parse(req)).not.toThrow();
  });

  test('content blocks discriminated union accepts text + image', () => {
    const req: UnifiedAiRequest = {
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,AAA' },
            },
          ],
        },
      ],
    };
    expect(() => UnifiedAiRequestSchema.parse(req)).not.toThrow();
  });

  test('rejects empty messages array', () => {
    const bad = { model: 'x', messages: [] };
    expect(() => UnifiedAiRequestSchema.parse(bad)).toThrow();
  });

  test('response round-trips with usage + latency + provider', () => {
    const res: UnifiedAiResponse = {
      id: 'chatcmpl-abc',
      object: 'chat.completion',
      model: 'gpt-4o-mini',
      created: 1_700_000_000,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'hello' },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      latencyMs: 420,
      provider: 'openai',
    };
    expect(UnifiedAiResponseSchema.parse(res)).toEqual(res);
  });
});

describe('nova stream schema', () => {
  test('each event-type arm parses', () => {
    const chunk = UnifiedStreamEventSchema.parse({
      type: 'chunk',
      chunk: {
        id: 'c1',
        object: 'chat.completion.chunk',
        model: 'x',
        created: 1,
        choices: [{ index: 0, delta: { content: 'hi' } }],
      },
    });
    expect(chunk.type).toBe('chunk');

    const tool = UnifiedStreamEventSchema.parse({
      type: 'tool_call',
      toolCall: {
        id: 't1',
        type: 'function',
        function: { name: 'foo', arguments: '{}' },
      },
    });
    expect(tool.type).toBe('tool_call');

    const err = UnifiedStreamEventSchema.parse({
      type: 'error',
      error: { message: 'boom', retryable: true },
    });
    expect(err.type).toBe('error');

    const done = UnifiedStreamEventSchema.parse({
      type: 'done',
      finish_reason: 'stop',
    });
    expect(done.type).toBe('done');
  });
});

describe('nova embeddings schema', () => {
  test('accepts string + array inputs', () => {
    expect(() =>
      UnifiedEmbeddingRequestSchema.parse({
        model: 'text-embedding-3-small',
        input: 'hello',
      }),
    ).not.toThrow();
    expect(() =>
      UnifiedEmbeddingRequestSchema.parse({
        model: 'text-embedding-3-small',
        input: ['a', 'b', 'c'],
      }),
    ).not.toThrow();
  });
});

describe('nova models schema', () => {
  test('ModelInfo requires id/created/owned_by but defaults capabilities', () => {
    const parsed = ModelInfoSchema.parse({
      id: 'gpt-4o-mini',
      object: 'model',
      created: 1_700_000_000,
      owned_by: 'openai',
    });
    expect(parsed.capabilities).toEqual([]);
  });

  test('capabilities enum constraint catches typos', () => {
    expect(() =>
      ModelInfoSchema.parse({
        id: 'x',
        object: 'model',
        created: 1,
        owned_by: 'y',
        capabilities: ['not-a-real-capability'],
      }),
    ).toThrow();
  });
});

describe('nova health schema', () => {
  test('healthy / unhealthy round-trip', () => {
    const now = new Date().toISOString();
    expect(() =>
      ProviderHealthSchema.parse({ state: 'healthy', lastChecked: now, latencyMs: 12 }),
    ).not.toThrow();
    expect(() =>
      ProviderHealthSchema.parse({ state: 'unhealthy', lastChecked: now, error: 'timeout' }),
    ).not.toThrow();
  });
});

describe('AiProvider interface', () => {
  test('a minimal adapter type-checks without streaming/embeddings/models', () => {
    // Compile-time-only: the object literal conforms to AiProvider.
    const stub: AiProvider = {
      name: 'stub',
      async createResponse(req) {
        return {
          id: 'x',
          object: 'chat.completion',
          model: req.model,
          created: 0,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '' },
              finish_reason: 'stop',
            },
          ],
        };
      },
    };
    expect(stub.name).toBe('stub');
  });
});
