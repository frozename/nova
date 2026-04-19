import type { PlannerToolDescriptor } from './schema.js';

/**
 * Pure prompt builder for the planner LLM. Takes the filtered tool
 * catalog, fleet context, and operator goal; returns the system +
 * user messages plus the `submit_plan` function definition.
 *
 * Separated from the tool/executor wiring so the prompt template can
 * be golden-file snapshot-tested without booting anything.
 */

export interface BuildPlannerPromptOptions {
  tools: PlannerToolDescriptor[];
  /** Compact fleet summary (healer snapshot, cost snapshot, etc.).
   *  Caller is responsible for keeping this within the model's window —
   *  this module pastes verbatim under a `FLEET CONTEXT:` header. */
  context: string;
  goal: string;
}

export interface BuildPlannerPromptResult {
  systemMessage: string;
  userMessage: string;
  /** JSON-schema function definition the model must call instead of
   *  emitting free text. Shape is compatible with OpenAI-style
   *  `tools: [{type:'function', function: ...}]` calling conventions
   *  that most chat models (incl. llama.cpp's OAI adapter) support. */
  submitPlanFunction: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const SYSTEM_TEMPLATE = `You are the llamactl operator-automation planner.
You translate natural-language operational goals into a short sequence of MCP tool calls.

RULES:
- You MUST respond by calling the \`submit_plan\` function. Never return free text.
- Plans must contain at most 20 steps. If a goal would need more, produce a one-step plan that calls a read tool (e.g. nova.ops.overview) so the operator can refine the goal.
- Prefer read-only tools. When a mutation is required, set dryRun: true on that step unless the operator's goal explicitly requests execution.
- Every step must include a short \`annotation\` explaining why that tool call is needed. Operators scan these during confirmation.
- Your top-level \`reasoning\` field summarises the plan as a whole — the "why" behind the chosen sequence.
- If a goal is ambiguous (missing target node, missing preset name, etc.), emit a one-step plan that runs a read tool to gather context rather than guessing.
- Only call tools listed under AVAILABLE TOOLS. Tools outside that list will be rejected by the executor.`;

function describeTool(t: PlannerToolDescriptor): string {
  const tierTag =
    t.tier === 'read'
      ? 'READ'
      : t.tier === 'mutation-dry-run-safe'
        ? 'MUTATION (dry-run-safe)'
        : 'MUTATION (destructive)';
  return `- \`${t.name}\` [${tierTag}]: ${t.description}`;
}

export function buildPlannerPrompt(
  opts: BuildPlannerPromptOptions,
): BuildPlannerPromptResult {
  const toolList = opts.tools.map(describeTool).join('\n');
  const systemMessage = [
    SYSTEM_TEMPLATE,
    '',
    'AVAILABLE TOOLS:',
    toolList || '(none)',
  ].join('\n');
  const userMessage = [
    'FLEET CONTEXT:',
    opts.context.trim().length > 0 ? opts.context.trim() : '(no context supplied)',
    '',
    'GOAL:',
    opts.goal.trim(),
  ].join('\n');

  const submitPlanFunction = {
    name: 'submit_plan',
    description:
      'Submit a plan — a short sequence of MCP tool calls — that, when executed, achieves the operator goal.',
    parameters: {
      type: 'object',
      required: ['steps', 'reasoning'],
      properties: {
        steps: {
          type: 'array',
          maxItems: 20,
          items: {
            type: 'object',
            required: ['tool', 'annotation'],
            properties: {
              tool: {
                type: 'string',
                description: 'Fully-qualified MCP tool name.',
              },
              args: {
                type: 'object',
                description: 'Arguments passed to the tool; shape validated by the tool itself.',
              },
              dryRun: {
                type: 'boolean',
                description:
                  'For mutation steps: when true, the executor runs the tool in dry-run mode first. Defaults to true for mutations and is ignored for read-only tools.',
              },
              annotation: {
                type: 'string',
                description: 'Short operator-readable justification for this step.',
              },
            },
          },
        },
        reasoning: {
          type: 'string',
          description: 'Top-level rationale — the "why" for the whole plan.',
        },
        requiresConfirmation: {
          type: 'boolean',
          description:
            'Default true. Set false only for all-read plans the planner judged safe to auto-execute.',
        },
      },
    },
  };

  return { systemMessage, userMessage, submitPlanFunction };
}
