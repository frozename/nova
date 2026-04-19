import { PlanSchema, type Plan, type PlannerToolDescriptor } from './schema.js';
import {
  DEFAULT_ALLOWLIST,
  filterTools,
  type AllowlistConfig,
} from './allowlist.js';
import { buildPlannerPrompt } from './prompt.js';

/**
 * Executor seam for `nova.operator.plan`.
 *
 * Split from the tool registration so N.4.2 can ship the MCP wiring +
 * end-to-end shape with a canned stub, and N.4.3 can drop in a real
 * dispatcher → LLM → tool-call-response pipeline without touching the
 * tool code or the tests that exercise its surface.
 *
 * The executor receives the prompt pieces `buildPlannerPrompt()`
 * produced, plus the filtered tool catalog (in case the model needs
 * it in its native function-calling format), and returns either a
 * raw plan blob (which the caller validates against PlanSchema) or a
 * failure reason the caller surfaces to the operator.
 */

export interface PlannerExecutorInput {
  systemMessage: string;
  userMessage: string;
  submitPlanFunction: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
  tools: PlannerToolDescriptor[];
}

export type PlannerExecutorResult =
  | { ok: true; rawPlan: unknown; trace?: Record<string, unknown> }
  | {
      ok: false;
      reason: 'model-error' | 'no-tool-call' | 'parse-failed';
      message: string;
      trace?: Record<string, unknown>;
    };

export interface PlannerExecutor {
  name: string;
  generate(input: PlannerExecutorInput): Promise<PlannerExecutorResult>;
}

/**
 * Canned stub: returns a one-step plan calling `nova.ops.overview`
 * with the operator's goal embedded in the annotation. Proves the
 * tool registration + validation + audit pipeline end-to-end without
 * a real LLM binding.
 *
 * Used as the default executor through N.4.2; N.4.3 replaces it with
 * a dispatcher-backed chat completion. Operators can still select
 * the stub explicitly via config to sanity-check the wiring.
 */
export const stubPlannerExecutor: PlannerExecutor = {
  name: 'stub',
  async generate(input) {
    return {
      ok: true,
      rawPlan: {
        steps: [
          {
            tool: 'nova.ops.overview',
            args: {},
            annotation:
              'stub-executor default: real model not bound yet — reading fleet state so the operator can refine the goal',
          },
        ],
        reasoning:
          `stub planner acknowledging goal; returning a single read-only overview call. ` +
          `Real LLM wiring lands in N.4.3. (${input.tools.length} tool${input.tools.length === 1 ? '' : 's'} in the allowlist)`,
        requiresConfirmation: false,
      },
      trace: {
        executor: 'stub',
        toolCount: input.tools.length,
      },
    };
  },
};

export interface RunPlannerOptions {
  goal: string;
  context: string;
  tools: PlannerToolDescriptor[];
  allowlist?: AllowlistConfig;
  executor?: PlannerExecutor;
}

export type RunPlannerResult =
  | {
      ok: true;
      plan: Plan;
      executor: string;
      toolsAvailable: string[];
      trace?: Record<string, unknown>;
    }
  | {
      ok: false;
      reason: 'executor-failed' | 'plan-shape-invalid' | 'empty-goal';
      message: string;
      executor?: string;
      rawPlan?: unknown;
      trace?: Record<string, unknown>;
    };

/**
 * Composable run: allowlist → prompt → executor → schema-validate.
 * Pure logic (aside from whatever the executor does) — no MCP, no
 * audit, no LLM. The `nova.operator.plan` tool in the MCP server
 * wraps this and adds those concerns.
 */
export async function runPlanner(opts: RunPlannerOptions): Promise<RunPlannerResult> {
  const goal = opts.goal.trim();
  if (goal.length === 0) {
    return { ok: false, reason: 'empty-goal', message: 'operator goal must be a non-empty string' };
  }
  const allowlist = opts.allowlist ?? DEFAULT_ALLOWLIST;
  const filtered = filterTools(opts.tools, allowlist);
  const prompt = buildPlannerPrompt({
    tools: filtered,
    context: opts.context,
    goal,
  });
  const executor = opts.executor ?? stubPlannerExecutor;
  const exec = await executor.generate({
    systemMessage: prompt.systemMessage,
    userMessage: prompt.userMessage,
    submitPlanFunction: prompt.submitPlanFunction,
    tools: filtered,
  });
  if (!exec.ok) {
    return {
      ok: false,
      reason: 'executor-failed',
      message: `${exec.reason}: ${exec.message}`,
      executor: executor.name,
      trace: exec.trace,
    };
  }
  const parsed = PlanSchema.safeParse(exec.rawPlan);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'plan-shape-invalid',
      message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      executor: executor.name,
      rawPlan: exec.rawPlan,
      trace: exec.trace,
    };
  }
  return {
    ok: true,
    plan: parsed.data,
    executor: executor.name,
    toolsAvailable: filtered.map((t) => t.name),
    trace: exec.trace,
  };
}
