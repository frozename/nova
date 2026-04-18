import { describe, expect, test } from 'bun:test';
import {
  UnifiedAiRequestSchema,
  UnifiedAiResponseSchema,
  ChatMessageSchema,
  createOpenAICompatProvider,
  type AiProvider,
} from '../src/index.js';

/**
 * Keep this smoke test honest: it asserts Nova's public surface
 * exists and round-trips a minimal chat request through the exported
 * schema. Any import-site drift (a file split, a renamed export, a
 * schema removed) will fail this test before it silently breaks the
 * consumers.
 */

describe('@nova/contracts public surface', () => {
  test('re-exports chat schemas', () => {
    const msg = ChatMessageSchema.parse({ role: 'user', content: 'hi' });
    expect(msg.content).toBe('hi');
  });

  test('round-trips a minimal request', () => {
    const req = UnifiedAiRequestSchema.parse({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(req.messages).toHaveLength(1);
  });

  test('validates a well-formed response', () => {
    const res = UnifiedAiResponseSchema.parse({
      id: 'cm_1',
      object: 'chat.completion',
      model: 'gpt-4o',
      created: 1,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        },
      ],
    });
    expect(res.choices[0]?.message.content).toBe('ok');
  });

  test('createOpenAICompatProvider returns an AiProvider shape', () => {
    const provider: AiProvider = createOpenAICompatProvider({
      name: 'test',
      baseUrl: 'http://localhost:9999/v1',
      apiKey: 'none',
    });
    expect(provider.name).toBe('test');
    expect(typeof provider.createResponse).toBe('function');
  });
});
