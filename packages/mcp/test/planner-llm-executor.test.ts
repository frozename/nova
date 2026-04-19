import { describe, expect, test } from 'bun:test';
import type {
  AiProvider,
  ChatMessage,
  UnifiedAiRequest,
  UnifiedAiResponse,
} from '@nova/contracts';
import { createLlmExecutor } from '../src/planner/llm-executor.js';
import type { PlannerToolDescriptor } from '../src/planner/schema.js';
import { buildPlannerPrompt } from '../src/planner/prompt.js';
import { runPlanner } from '../src/planner/executor.js';

/**
 * Unit tests for the LLM-backed planner executor. Uses a fake
 * AiProvider that records the request + returns a scripted response.
 * No real model, no network.
 */

function fakeProvider(opts: {
  handler: (req: UnifiedAiRequest) => UnifiedAiResponse | Promise<UnifiedAiResponse>;
  name?: string;
}): { provider: AiProvider; requests: UnifiedAiRequest[] } {
  const requests: UnifiedAiRequest[] = [];
  const provider: AiProvider = {
    name: opts.name ?? 'fake',
    async createResponse(req) {
      requests.push(req);
      return opts.handler(req);
    },
  };
  return { provider, requests };
}

function chatResponseWithToolCall(
  args: string,
  opts: { finish?: 'tool_calls' | 'stop'; model?: string; name?: string } = {},
): UnifiedAiResponse {
  return {
    id: 'resp-1',
    object: 'chat.completion',
    model: opts.model ?? 'gpt-fake',
    created: 1_700_000_000,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: opts.name ?? 'submit_plan',
                arguments: args,
              },
            },
          ],
        },
        finish_reason: opts.finish ?? 'tool_calls',
      },
    ],
  };
}

function chatResponseWithText(text: string, finish: 'stop' | 'length' = 'stop'): UnifiedAiResponse {
  return {
    id: 'resp-1',
    object: 'chat.completion',
    model: 'gpt-fake',
    created: 1_700_000_000,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: text,
        },
        finish_reason: finish,
      },
    ],
  };
}

const sampleTools: PlannerToolDescriptor[] = [
  {
    name: 'llamactl.catalog.list',
    description: 'List curated models on the target node.',
    inputSchema: { type: 'object' },
    tier: 'read',
  },
];

describe('createLlmExecutor — request construction', () => {
  test('sends system + user messages, submit_plan tool, tool_choice pinned', async () => {
    const planShape = JSON.stringify({
      steps: [
        { tool: 'llamactl.catalog.list', annotation: 'read' },
      ],
      reasoning: 'just listing',
    });
    const { provider, requests } = fakeProvider({
      handler: () => chatResponseWithToolCall(planShape),
    });
    const executor = createLlmExecutor({ provider, model: 'gpt-fake' });
    const { systemMessage, userMessage, submitPlanFunction } = buildPlannerPrompt({
      tools: sampleTools,
      context: 'node gpu1 up',
      goal: 'list everything',
    });
    const result = await executor.generate({
      systemMessage,
      userMessage,
      submitPlanFunction,
      tools: sampleTools,
    });
    expect(result.ok).toBe(true);
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.model).toBe('gpt-fake');
    const msgs = req.messages as ChatMessage[];
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content).toBe(systemMessage);
    expect(msgs[1]!.role).toBe('user');
    expect(msgs[1]!.content).toBe(userMessage);
    // tool_choice forces submit_plan.
    expect(req.tool_choice).toEqual({
      type: 'function',
      function: { name: 'submit_plan' },
    });
    expect(req.tools).toHaveLength(1);
    expect(req.tools![0]!.function.name).toBe('submit_plan');
    // request_id stamped in providerOptions.
    expect(typeof req.providerOptions?.request_id).toBe('string');
  });

  test('executor name bakes in provider + model', () => {
    const { provider } = fakeProvider({ handler: () => chatResponseWithText('x') });
    const executor = createLlmExecutor({ provider, model: 'gpt-5' });
    expect(executor.name).toBe('llm:fake:gpt-5');
  });
});

describe('createLlmExecutor — success path', () => {
  test('JSON-parses tool-call arguments and returns rawPlan', async () => {
    const plan = {
      steps: [
        { tool: 'llamactl.catalog.list', args: {}, annotation: 'read' },
      ],
      reasoning: 'list',
      requiresConfirmation: true,
    };
    const { provider } = fakeProvider({
      handler: () => chatResponseWithToolCall(JSON.stringify(plan)),
    });
    const executor = createLlmExecutor({ provider, model: 'gpt-fake' });
    const out = await executor.generate({
      systemMessage: 'sys',
      userMessage: 'user',
      submitPlanFunction: { name: 'submit_plan', description: 'd', parameters: {} },
      tools: sampleTools,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.rawPlan).toEqual(plan);
    expect(out.trace?.provider).toBe('fake');
  });

  test('end-to-end via runPlanner + PlanSchema validation', async () => {
    const plan = {
      steps: [
        { tool: 'llamactl.catalog.list', args: {}, annotation: 'list models' },
      ],
      reasoning: 'need to read first',
    };
    const { provider } = fakeProvider({
      handler: () => chatResponseWithToolCall(JSON.stringify(plan)),
    });
    const executor = createLlmExecutor({ provider, model: 'gpt-fake' });
    const result = await runPlanner({
      goal: 'list multimodal candidates',
      context: '',
      tools: sampleTools,
      executor,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.plan.steps).toHaveLength(1);
    expect(result.executor).toBe('llm:fake:gpt-fake');
  });
});

describe('createLlmExecutor — failure modes', () => {
  test('provider throws → model-error', async () => {
    const { provider } = fakeProvider({
      handler: () => { throw new Error('upstream 503'); },
    });
    const executor = createLlmExecutor({ provider, model: 'gpt-fake' });
    const out = await executor.generate({
      systemMessage: 's',
      userMessage: 'u',
      submitPlanFunction: { name: 'submit_plan', description: 'd', parameters: {} },
      tools: sampleTools,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('model-error');
    expect(out.message).toContain('upstream 503');
  });

  test('free-text response (no tool call) → no-tool-call with text excerpt', async () => {
    const { provider } = fakeProvider({
      handler: () => chatResponseWithText('I cannot comply with that request.'),
    });
    const executor = createLlmExecutor({ provider, model: 'gpt-fake' });
    const out = await executor.generate({
      systemMessage: 's',
      userMessage: 'u',
      submitPlanFunction: { name: 'submit_plan', description: 'd', parameters: {} },
      tools: sampleTools,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('no-tool-call');
    expect(out.message).toContain('stop');
    expect(out.message).toContain('I cannot comply');
  });

  test('wrong tool name → no-tool-call', async () => {
    const { provider } = fakeProvider({
      handler: () =>
        chatResponseWithToolCall('{"x":1}', { name: 'not_submit_plan' }),
    });
    const executor = createLlmExecutor({ provider, model: 'gpt-fake' });
    const out = await executor.generate({
      systemMessage: 's',
      userMessage: 'u',
      submitPlanFunction: { name: 'submit_plan', description: 'd', parameters: {} },
      tools: sampleTools,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('no-tool-call');
  });

  test('malformed JSON arguments → parse-failed with truncated raw', async () => {
    const { provider } = fakeProvider({
      handler: () => chatResponseWithToolCall('{not valid json'),
    });
    const executor = createLlmExecutor({ provider, model: 'gpt-fake' });
    const out = await executor.generate({
      systemMessage: 's',
      userMessage: 'u',
      submitPlanFunction: { name: 'submit_plan', description: 'd', parameters: {} },
      tools: sampleTools,
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('parse-failed');
    expect(out.trace?.rawArguments).toContain('{not valid json');
  });

  test('schema-invalid plan surfaces as plan-shape-invalid through runPlanner', async () => {
    // Valid JSON, but missing required `annotation` on the step.
    const bad = { steps: [{ tool: 'llamactl.catalog.list' }], reasoning: 'x' };
    const { provider } = fakeProvider({
      handler: () => chatResponseWithToolCall(JSON.stringify(bad)),
    });
    const executor = createLlmExecutor({ provider, model: 'gpt-fake' });
    const result = await runPlanner({
      goal: 'something',
      context: '',
      tools: sampleTools,
      executor,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('plan-shape-invalid');
  });
});
