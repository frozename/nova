import { z } from 'zod';

/**
 * Planner data shapes. Separated from the tool-registration layer so
 * tests can assert on pure functions without booting a full
 * McpServer. Imported by `@nova/mcp` when the `nova.operator.plan`
 * tool is wired in (N.4.2+).
 *
 * Hard-cap plan length: 20 steps. Real operator flows rarely need
 * more; plans that exceed it are usually the model spiraling on an
 * under-specified goal. Reject over-long plans at parse time — the
 * operator sees a clear error rather than a 40-step sequence.
 */

export const PlanStepSchema = z.object({
  /** Fully-qualified MCP tool name (`llamactl.catalog.list`, etc.). */
  tool: z.string().min(1),
  /** Arguments passed to the tool. Opaque to the planner; each tool
   *  does its own Zod-validation of shape on invocation. */
  args: z.record(z.string(), z.unknown()).default({}),
  /** When omitted on a mutation step the executor treats it as
   *  `true` (dry-run-first). Read tools ignore this field. */
  dryRun: z.boolean().optional(),
  /** Short model-written rationale for this step. Required on every
   *  step — forces the model to justify each tool call and gives
   *  the operator readable scan-text during confirmation. */
  annotation: z.string().min(1),
});
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const PlanSchema = z.object({
  steps: z.array(PlanStepSchema).max(20, 'plan exceeds 20-step hard cap'),
  /** Top-level reasoning — the "why" for the whole plan, separate
   *  from per-step annotations. Renders above the step list in
   *  operator confirmation UI. */
  reasoning: z.string().min(1),
  /** Default true. Operators running `--auto` may see this flipped
   *  to false for all-read plans the model judged safe; never relied
   *  on blindly by the executor, which applies its own safety rules. */
  requiresConfirmation: z.boolean().default(true),
});
export type Plan = z.infer<typeof PlanSchema>;

/** Classification for a tool name by policy tier. Used by the
 *  allowlist filter + the executor's dry-run-cascade decision. */
export type ToolSafetyTier = 'read' | 'mutation-dry-run-safe' | 'mutation-destructive';

/**
 * Catalog entry fed to the planner prompt. Each tool contributes a
 * JSON-schema-shaped function definition to the model's
 * function-calling surface.
 */
export interface PlannerToolDescriptor {
  name: string;
  description: string;
  /** JSON Schema of the tool's inputs — must come from the MCP
   *  tool's own `inputSchema`. The planner module doesn't derive
   *  this; the facade is responsible for handing it in. */
  inputSchema: Record<string, unknown>;
  tier: ToolSafetyTier;
}
