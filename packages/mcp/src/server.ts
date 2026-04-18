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
 *   * `nova.operator.plan(goal)` — the LLM-backed "translate intent
 *     into tool calls" tool. Needs a model binding + safety shape;
 *     warrants its own design pass.
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

export function buildNovaMcpServer(opts?: { name?: string; version?: string }): McpServer {
  const server = new McpServer({
    name: opts?.name ?? 'nova',
    version: opts?.version ?? '0.0.0',
  });

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

  return server;
}
