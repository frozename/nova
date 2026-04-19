import type {
  AiProvider,
  UnifiedAiRequest,
  UnifiedAiResponse,
} from '@nova/contracts';
import type {
  PlannerExecutor,
  PlannerExecutorInput,
  PlannerExecutorResult,
} from './executor.js';

/**
 * Real LLM-backed PlannerExecutor. Wraps any `AiProvider` (from
 * `@nova/contracts`) — OpenAI, Anthropic, Together, a local
 * llama.cpp served via Nova's `createOpenAICompatProvider`, a
 * sirius-gateway upstream — and turns a planner prompt into a
 * single chat completion call.
 *
 * The executor forces the `submit_plan` tool via `tool_choice:
 * { type: 'function', function: { name: 'submit_plan' } }`, so
 * any reasonable chat-function-calling model emits exactly one
 * tool call. The function's `arguments` string is JSON-parsed and
 * handed back as `rawPlan`; the caller validates against
 * `PlanSchema`.
 *
 * Failure modes we distinguish:
 *   - `model-error`: provider threw (network, auth, timeout).
 *   - `no-tool-call`: model responded with free text / no tool
 *     invocation / wrong tool name. Often caused by a too-small
 *     model. Operator-visible signal; retryable with a stronger
 *     model.
 *   - `parse-failed`: tool call present but arguments aren't
 *     valid JSON. Rare — models that support function calling
 *     almost always emit well-formed JSON.
 *
 * Stateless; safe to reuse across many plans.
 */

export interface CreateLlmExecutorOptions {
  provider: AiProvider;
  /** Model id as the provider knows it (e.g. `gpt-4o-mini`,
   *  `claude-opus-4.6`, `llama-3.3-70b`). */
  model: string;
  /** Sampling temperature passed through to the provider. Lower is
   *  better for planner output — the model should commit to a
   *  concrete plan, not hedge. Default 0.2. */
  temperature?: number;
  /** Max tokens the planner is allowed to consume on the response.
   *  Default 2048 — more than enough for a 20-step plan. */
  maxTokens?: number;
  /** Optional override for the generated request_id; defaults to
   *  a time-keyed random slug. */
  requestId?: () => string;
}

function defaultRequestId(): string {
  return `planner-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function extractToolCall(
  response: UnifiedAiResponse,
): { arguments: string } | null {
  const choice = response.choices[0];
  if (!choice) return null;
  const toolCalls = choice.message.tool_calls ?? [];
  for (const tc of toolCalls) {
    if (tc.function.name === 'submit_plan') {
      return { arguments: tc.function.arguments };
    }
  }
  return null;
}

export function createLlmExecutor(
  opts: CreateLlmExecutorOptions,
): PlannerExecutor {
  const requestId = opts.requestId ?? defaultRequestId;
  return {
    name: `llm:${opts.provider.name}:${opts.model}`,
    async generate(input: PlannerExecutorInput): Promise<PlannerExecutorResult> {
      const request: UnifiedAiRequest = {
        model: opts.model,
        messages: [
          { role: 'system', content: input.systemMessage },
          { role: 'user', content: input.userMessage },
        ],
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 2048,
        tools: [
          {
            type: 'function',
            function: {
              name: input.submitPlanFunction.name,
              description: input.submitPlanFunction.description,
              parameters: input.submitPlanFunction.parameters,
            },
          },
        ],
        tool_choice: {
          type: 'function',
          function: { name: input.submitPlanFunction.name },
        },
      };
      // `request_id` is not part of UnifiedAiRequest (adapter-specific).
      // We attach it as providerOptions so adapters that surface it
      // (llamactl, sirius) can forward.
      const requestWithId: UnifiedAiRequest = {
        ...request,
        providerOptions: { request_id: requestId() },
      };

      let response: UnifiedAiResponse;
      try {
        response = await opts.provider.createResponse(requestWithId);
      } catch (err) {
        return {
          ok: false,
          reason: 'model-error',
          message: (err as Error).message || 'provider.createResponse threw',
        };
      }

      const toolCall = extractToolCall(response);
      if (!toolCall) {
        const finish = response.choices[0]?.finish_reason ?? 'unknown';
        const textFallback =
          typeof response.choices[0]?.message.content === 'string'
            ? (response.choices[0].message.content as string).slice(0, 300)
            : '';
        return {
          ok: false,
          reason: 'no-tool-call',
          message: `model returned ${finish} without a submit_plan tool call${textFallback ? `: ${textFallback}` : ''}`,
          trace: { finishReason: finish, model: response.model },
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(toolCall.arguments);
      } catch (err) {
        return {
          ok: false,
          reason: 'parse-failed',
          message: `submit_plan arguments are not valid JSON: ${(err as Error).message}`,
          trace: { rawArguments: toolCall.arguments.slice(0, 500) },
        };
      }

      return {
        ok: true,
        rawPlan: parsed,
        trace: {
          model: response.model,
          provider: response.provider ?? opts.provider.name,
          usage: response.usage,
          latencyMs: response.latencyMs,
        },
      };
    },
  };
}
