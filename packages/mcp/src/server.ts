import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { appendAudit, toTextContent } from '@nova/mcp-shared';
import {
  defaultEmbersynthConfigPath,
  defaultKubeconfigPath,
  defaultSiriusProvidersPath,
} from './paths.js';
import { runPlanner, type PlannerExecutor } from './planner/executor.js';
import type { AllowlistConfig } from './planner/allowlist.js';
import type { PlannerToolDescriptor } from './planner/schema.js';
import { computeCostSnapshot } from './cost/snapshot.js';

/**
 * `@nova/mcp` — unified MCP facade across the llamactl family.
 *
 * Today's surface is deliberately narrow: two roll-up tools that an
 * operator (or an LLM pretending to be one) can call to answer
 * "what's my fleet look like right now?" without spawning three
 * subprocess servers and merging responses themselves.
 *
 *   * `nova.ops.overview`      — reads the three operator YAMLs
 *     llamactl authors (kubeconfig, sirius-providers.yaml,
 *     embersynth.yaml) and returns a unified snapshot:
 *     agents + gateways + providers + profiles + synthetic models.
 *   * `nova.ops.healthcheck`   — probes each cloud-bound node's
 *     endpoint and reports reachability. Fails-soft per probe so a
 *     single flaky URL doesn't tank the report.
 *
 * Deliberately out of scope for this slice:
 *   * Spawning @llamactl/mcp, @sirius/mcp, @embersynth/mcp as child
 *     stdio processes and proxying their tool surfaces one-for-one.
 *     Future work; for now, MCP clients connect to each server
 *     directly (they're designed to multiplex).
 *   * `nova.operator.plan(goal)` — N.4.2 ships the tool surface +
 *     prompt/allowlist/schema plumbing wired to an injectable
 *     executor. The default executor is a canned stub so operators
 *     can sanity-check the pipeline; the real LLM binding lands in
 *     N.4.3 as a new executor implementation.
 */

const SERVER_SLUG = 'nova';

function readYamlIfExists(path: string): unknown | null {
  if (!existsSync(path)) return null;
  try {
    return parseYaml(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

interface KubeconfigNode {
  name: string;
  endpoint?: string;
  kind?: 'agent' | 'gateway' | 'provider' | 'cloud';
  cloud?: { provider: string; baseUrl: string };
  provider?: { gateway: string; providerName: string };
}

interface KubeconfigShape {
  currentContext?: string;
  contexts?: Array<{ name: string; cluster: string }>;
  clusters?: Array<{ name: string; nodes?: KubeconfigNode[] }>;
}

interface SiriusProvidersShape {
  providers?: Array<{
    name: string;
    kind: string;
    baseUrl?: string;
    apiKeyRef?: string;
    displayName?: string;
  }>;
}

interface EmbersynthShape {
  server?: { host?: string; port?: number };
  nodes?: Array<{
    id: string;
    label?: string;
    enabled?: boolean;
    capabilities?: string[];
    tags?: string[];
    priority?: number;
  }>;
  profiles?: Array<{ id: string; label?: string }>;
  syntheticModels?: Record<string, string>;
}

function resolveKind(n: KubeconfigNode): 'agent' | 'gateway' | 'provider' {
  if (n.kind === 'gateway' || n.kind === 'cloud') return 'gateway';
  if (n.kind === 'agent' || n.kind === 'provider') return n.kind;
  if (n.provider) return 'provider';
  if (n.cloud) return 'gateway';
  return 'agent';
}

async function probeEndpoint(url: string, timeoutMs = 1500): Promise<{ ok: boolean; status: number; error?: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, status: 0, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

export interface BuildNovaMcpServerOptions {
  name?: string;
  version?: string;
  /** Injectable planner executor — defaults to the canned stub until
   *  N.4.3 wires a real LLM-backed implementation. Tests pass their
   *  own implementation to assert shape without spinning up a model. */
  plannerExecutor?: PlannerExecutor;
  /** Allowlist override used by `nova.operator.plan`. Defaults to the
   *  DEFAULT_ALLOWLIST shipped with @nova/mcp. */
  plannerAllowlist?: AllowlistConfig;
  /** Tool catalog the planner advertises to the executor. Defaults to
   *  an empty list — `nova.operator.plan` can still run (the stub
   *  acknowledges the goal), but real planning needs the MCP client
   *  or a future catalog-discovery helper to populate this. */
  plannerTools?: PlannerToolDescriptor[];
}

export function buildNovaMcpServer(opts?: BuildNovaMcpServerOptions): McpServer {
  const server = new McpServer({
    name: opts?.name ?? 'nova',
    version: opts?.version ?? '0.0.0',
  });
  const plannerTools = opts?.plannerTools ?? [];
  const plannerAllowlist = opts?.plannerAllowlist;
  const plannerExecutor = opts?.plannerExecutor;

  server.registerTool(
    'nova.ops.overview',
    {
      title: 'Unified operator snapshot',
      description:
        'Read the three operator YAMLs (kubeconfig, sirius-providers.yaml, embersynth.yaml) that llamactl authors and return a single normalized view: agents + gateways + providers + profiles + synthetic models. Missing files surface as empty sections, not errors.',
      inputSchema: {
        kubeconfigPath: z.string().optional(),
        siriusProvidersPath: z.string().optional(),
        embersynthConfigPath: z.string().optional(),
      },
    },
    async (input) => {
      const kubePath = input.kubeconfigPath ?? defaultKubeconfigPath();
      const siriusPath = input.siriusProvidersPath ?? defaultSiriusProvidersPath();
      const embPath = input.embersynthConfigPath ?? defaultEmbersynthConfigPath();

      const kube = readYamlIfExists(kubePath) as KubeconfigShape | null;
      const sirius = readYamlIfExists(siriusPath) as SiriusProvidersShape | null;
      const emb = readYamlIfExists(embPath) as EmbersynthShape | null;

      const ctx = kube?.contexts?.find((c) => c.name === kube.currentContext);
      const cluster = kube?.clusters?.find((c) => c.name === ctx?.cluster);
      const kubeNodes = cluster?.nodes ?? [];
      const agents = kubeNodes.filter((n) => resolveKind(n) === 'agent').map((n) => ({
        name: n.name,
        endpoint: n.endpoint ?? null,
      }));
      const gateways = kubeNodes.filter((n) => resolveKind(n) === 'gateway').map((n) => ({
        name: n.name,
        provider: n.cloud?.provider ?? null,
        baseUrl: n.cloud?.baseUrl ?? null,
      }));
      const siriusProviders = (sirius?.providers ?? []).map((p) => ({
        name: p.name,
        kind: p.kind,
        baseUrl: p.baseUrl ?? null,
        displayName: p.displayName ?? null,
      }));
      const embersynthProfiles = emb?.profiles?.map((p) => ({ id: p.id, label: p.label ?? p.id })) ?? [];
      const syntheticModels = emb?.syntheticModels ?? {};

      appendAudit({ server: SERVER_SLUG, tool: 'nova.ops.overview', input });
      return toTextContent({
        paths: {
          kubeconfig: existsSync(kubePath) ? kubePath : null,
          siriusProviders: existsSync(siriusPath) ? siriusPath : null,
          embersynthConfig: existsSync(embPath) ? embPath : null,
        },
        context: ctx?.name ?? null,
        cluster: cluster?.name ?? null,
        agents,
        gateways,
        siriusProviders,
        embersynthProfiles,
        syntheticModels,
      });
    },
  );

  server.registerTool(
    'nova.ops.healthcheck',
    {
      title: 'Gateway reachability probe',
      description:
        'Issue a GET against each gateway node\'s baseUrl and each sirius provider\'s baseUrl and report reachability. Fails soft per probe so a single unreachable endpoint does not tank the report.',
      inputSchema: {
        kubeconfigPath: z.string().optional(),
        siriusProvidersPath: z.string().optional(),
        timeoutMs: z.number().int().positive().max(30000).default(1500),
      },
    },
    async (input) => {
      const kubePath = input.kubeconfigPath ?? defaultKubeconfigPath();
      const siriusPath = input.siriusProvidersPath ?? defaultSiriusProvidersPath();
      const timeoutMs = input.timeoutMs ?? 1500;

      const kube = readYamlIfExists(kubePath) as KubeconfigShape | null;
      const sirius = readYamlIfExists(siriusPath) as SiriusProvidersShape | null;
      const ctx = kube?.contexts?.find((c) => c.name === kube.currentContext);
      const cluster = kube?.clusters?.find((c) => c.name === ctx?.cluster);
      const gateways = (cluster?.nodes ?? [])
        .filter((n) => resolveKind(n) === 'gateway' && n.cloud?.baseUrl)
        .map((n) => ({ name: n.name, baseUrl: n.cloud!.baseUrl }));

      const gatewayProbes = await Promise.all(
        gateways.map(async (g) => ({
          name: g.name,
          baseUrl: g.baseUrl,
          ...(await probeEndpoint(g.baseUrl, timeoutMs)),
        })),
      );
      const providerProbes = await Promise.all(
        (sirius?.providers ?? [])
          .filter((p) => typeof p.baseUrl === 'string' && p.baseUrl.length > 0)
          .map(async (p) => ({
            name: p.name,
            kind: p.kind,
            baseUrl: p.baseUrl!,
            ...(await probeEndpoint(p.baseUrl!, timeoutMs)),
          })),
      );

      appendAudit({ server: SERVER_SLUG, tool: 'nova.ops.healthcheck', input });
      return toTextContent({
        timeoutMs,
        gateways: gatewayProbes,
        siriusProviders: providerProbes,
      });
    },
  );

  server.registerTool(
    'nova.ops.cost.snapshot',
    {
      title: 'Cost snapshot with optional dollar estimate',
      description:
        'Aggregate recorded usage JSONL under ~/.llamactl/usage/ (or $LLAMACTL_USAGE_DIR) for the last `days` (default 7, max 90) into roll-ups per provider and per provider/model. When pricing YAMLs exist under ~/.llamactl/pricing/ (or $LLAMACTL_PRICING_DIR / override via pricingDir), each record is joined against its (provider, model) rate and the estimated_cost_usd rolls up into group + grand totals. Missing pricing for a given (provider, model) leaves that group\'s cost blank and increments recordsMissingPricing; the snapshot never fails on missing pricing.',
      inputSchema: {
        days: z.number().int().positive().max(90).default(7),
        dir: z.string().optional(),
        pricingDir: z.string().optional(),
        disablePricing: z.boolean().optional(),
      },
    },
    async (input) => {
      const snapshotOpts: Parameters<typeof computeCostSnapshot>[0] = {
        days: input.days ?? 7,
      };
      if (input.dir !== undefined) snapshotOpts.dir = input.dir;
      if (input.disablePricing === true) {
        snapshotOpts.pricingDir = null;
      } else if (input.pricingDir !== undefined) {
        snapshotOpts.pricingDir = input.pricingDir;
      }
      const snapshot = computeCostSnapshot(snapshotOpts);
      appendAudit({
        server: SERVER_SLUG,
        tool: 'nova.ops.cost.snapshot',
        input: {
          days: input.days ?? 7,
          dir: input.dir ?? null,
          pricingDir: input.pricingDir ?? null,
          disablePricing: input.disablePricing === true,
        },
        result: {
          filesScanned: snapshot.filesScanned,
          totalRequests: snapshot.totalRequests,
          totalTokens: snapshot.totalTokens,
          totalEstimatedCostUsd: snapshot.totalEstimatedCostUsd ?? null,
          pricingFilesLoaded: snapshot.pricingFilesLoaded,
        },
      });
      return toTextContent(snapshot);
    },
  );

  server.registerTool(
    'nova.operator.plan',
    {
      title: 'Translate an operator goal into an MCP tool-call plan',
      description:
        'Given a natural-language operational goal, produces a short sequence of MCP tool calls that, when executed, achieve the goal. The returned plan is validated against PlanSchema (max 20 steps, required per-step annotations). Tool allowlist filters which MCP tools the planner is allowed to propose. Default executor is a canned stub until an LLM-backed executor is bound (N.4.3); the wire shape is identical across executors.',
      inputSchema: {
        goal: z.string().min(1, 'goal must be non-empty'),
        context: z
          .string()
          .default('')
          .describe('Compact fleet snapshot string; rendered verbatim under FLEET CONTEXT.'),
      },
    },
    async (input) => {
      const result = await runPlanner({
        goal: input.goal,
        context: input.context ?? '',
        tools: plannerTools,
        ...(plannerAllowlist ? { allowlist: plannerAllowlist } : {}),
        ...(plannerExecutor ? { executor: plannerExecutor } : {}),
      });
      appendAudit({
        server: SERVER_SLUG,
        tool: 'nova.operator.plan',
        input: { goal: input.goal, contextLen: (input.context ?? '').length },
        result: result.ok
          ? {
              outcome: 'ok',
              executor: result.executor,
              stepCount: result.plan.steps.length,
            }
          : {
              outcome: 'failed',
              reason: result.reason,
              executor: result.executor ?? null,
            },
      });
      if (!result.ok) {
        return toTextContent({
          ok: false,
          reason: result.reason,
          message: result.message,
          executor: result.executor ?? null,
          rawPlan: result.rawPlan ?? null,
        });
      }
      return toTextContent({
        ok: true,
        executor: result.executor,
        toolsAvailable: result.toolsAvailable,
        plan: result.plan,
      });
    },
  );

  return server;
}
