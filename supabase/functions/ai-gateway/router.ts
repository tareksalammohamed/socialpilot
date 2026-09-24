import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import { getAdapter, ProviderCallError, type ChatResult } from './providers.ts';

// ---------------------------------------------------------------------------
// Smart Model Router
//
// Agents never name a model. They ask for a task's required capabilities;
// this router looks across every enabled, healthy model from every enabled
// provider, ranks the candidates per the active routing policy, and walks
// down the list until one succeeds — recording every attempt.
// ---------------------------------------------------------------------------

export type RoutingPolicy = 'smart_balanced' | 'free_first' | 'lowest_cost' | 'best_quality' | 'fastest';

export type CapabilityName = 'text_generation' | 'vision' | 'reasoning' | 'tool_calling' | 'structured_output' | 'web_search';

export type CapabilityRequest = {
  requiredCapabilities: CapabilityName[];
  preferredCapabilities?: CapabilityName[];
};

type CandidateModel = {
  provider_key: string;
  model_id: string;
  is_free: boolean;
  input_cost_per_1k: number | null;
  output_cost_per_1k: number | null;
  quality_score: number;
  avg_latency_ms: number | null;
  success_count: number;
  failure_count: number;
  circuit_state: string;
  circuit_opened_at: string | null;
  reasoning: boolean;
  tool_calling: boolean;
  structured_output: boolean;
};

type ProviderRow = {
  provider_key: string;
  enabled: boolean;
  priority: number;
  allow_paid: boolean;
  failover_enabled: boolean;
};

// Statuses that mean "try the next candidate" rather than "stop and report
// the error" — matches spec's Failover vs Non-Failover error classes.
const FAILOVER_STATUSES = new Set([400, 401, 403, 404, 408, 409, 422, 429, 500, 502, 503, 504]);
const CIRCUIT_OPEN_COOLDOWN_MS = 5 * 60 * 1000;
const CONSECUTIVE_FAILURES_TO_OPEN = 5;
const MAX_ATTEMPTS = 12;

export type RunResult = {
  content: string;
  tokensIn: number;
  tokensOut: number;
  providerUsed: string;
  modelUsed: string;
  fallbackCount: number;
  fallbackLog: Array<{ provider: string; model: string; error: string }>;
  citations?: Array<{ url: string; title: string; content: string }>;
};

export class NoModelAvailableError extends Error {
  constructor() {
    super('لا يوجد Model متاح ومناسب لهذه المهمة. تأكد أن Super Admin أضّاف Provider واحد على الأقل وفعّله.');
  }
}

export class NonFailoverError extends Error {}

function isFailoverEligible(err: unknown): boolean {
  if (err instanceof ProviderCallError) return FAILOVER_STATUSES.has(err.status);
  // Network errors, timeouts, JSON parse failures on the model's output —
  // all failover-eligible per spec items 9 and 20.
  return true;
}

function effectiveCircuitOpen(m: CandidateModel): boolean {
  if (m.circuit_state !== 'open') return false;
  if (!m.circuit_opened_at) return true;
  const openedAt = new Date(m.circuit_opened_at).getTime();
  return Date.now() - openedAt < CIRCUIT_OPEN_COOLDOWN_MS;
}

async function loadCandidates(
  supabase: SupabaseClient,
  requiredCapabilities: CapabilityRequest['requiredCapabilities']
): Promise<{ candidates: CandidateModel[]; providers: Map<string, ProviderRow> }> {
  const [providersRes, modelsRes] = await Promise.all([
    supabase.from('ai_providers').select('provider_key, enabled, priority, allow_paid, failover_enabled'),
    supabase
      .from('ai_models')
      .select(
        'provider_key, model_id, is_free, input_cost_per_1k, output_cost_per_1k, quality_score, avg_latency_ms, success_count, failure_count, circuit_state, circuit_opened_at, status, vision, reasoning, tool_calling, structured_output'
      )
      .neq('status', 'disabled'),
  ]);

  const providers = new Map<string, ProviderRow>();
  for (const p of (providersRes.data ?? []) as ProviderRow[]) {
    if (p.enabled) providers.set(p.provider_key, p);
  }

  type ModelRow = CandidateModel & {
    status: string;
    vision: boolean;
    reasoning: boolean;
    tool_calling: boolean;
    structured_output: boolean;
  };

  const candidates = ((modelsRes.data ?? []) as ModelRow[])
    .filter((m) => providers.has(m.provider_key))
    .filter((m) => !effectiveCircuitOpen(m))
    .filter((m) => {
      for (const cap of requiredCapabilities) {
        if (cap === 'text_generation') continue; // baseline, every chat model has it
        if (cap === 'vision' && !m.vision) return false;
        if (cap === 'reasoning' && !m.reasoning) return false;
        if (cap === 'tool_calling' && !m.tool_calling) return false;
        if (cap === 'structured_output' && !m.structured_output) return false;
        // web_search isn't a per-model flag — it's the OpenRouter `web`
        // plugin, which works the same across every model that provider
        // routes to (see providers.ts). No other adapter here implements
        // it, so any other provider is simply not a candidate.
        if (cap === 'web_search' && m.provider_key !== 'openrouter') return false;
      }
      return true;
    })
    .map((m) => ({
      provider_key: m.provider_key,
      model_id: m.model_id,
      is_free: m.is_free,
      input_cost_per_1k: m.input_cost_per_1k,
      output_cost_per_1k: m.output_cost_per_1k,
      quality_score: m.quality_score,
      avg_latency_ms: m.avg_latency_ms,
      success_count: m.success_count,
      failure_count: m.failure_count,
      circuit_state: m.circuit_state,
      circuit_opened_at: m.circuit_opened_at,
      reasoning: m.reasoning,
      tool_calling: m.tool_calling,
      structured_output: m.structured_output,
    }));

  return { candidates, providers };
}

function successRate(m: CandidateModel): number {
  const total = m.success_count + m.failure_count;
  return total === 0 ? 0.75 : m.success_count / total; // unproven models start neutral, not last
}

function totalCost(m: CandidateModel): number {
  return (m.input_cost_per_1k ?? 0) + (m.output_cost_per_1k ?? 0);
}

function rankCandidates(
  candidates: CandidateModel[],
  providers: Map<string, ProviderRow>,
  policy: RoutingPolicy,
  allowPaidFallback: boolean,
  preferredCapabilities: CapabilityName[] = []
): CandidateModel[] {
  let pool = candidates.filter((m) => {
    const provider = providers.get(m.provider_key);
    if (!provider) return false;
    if (!m.is_free && !provider.allow_paid) return false;
    return true;
  });

  // If free models can cover the task, keep paid ones only as fallback
  // material — they still get appended (never dropped) unless paid
  // fallback is disabled entirely.
  const hasFree = pool.some((m) => m.is_free);
  if (!hasFree && !allowPaidFallback) {
    pool = pool.filter((m) => m.is_free);
  }

  const providerPriority = (m: CandidateModel) => providers.get(m.provider_key)?.priority ?? 999;
  const preferenceScore = (m: CandidateModel) => preferredCapabilities.reduce((score, capability) => score + (capability === 'reasoning' ? Number(m.reasoning) : capability === 'tool_calling' ? Number(m.tool_calling) : capability === 'structured_output' ? Number(m.structured_output) : 0), 0);

  const comparators: Record<RoutingPolicy, (a: CandidateModel, b: CandidateModel) => number> = {
    free_first: (a, b) =>
      Number(b.is_free) - Number(a.is_free) ||
      providerPriority(a) - providerPriority(b) ||
      b.quality_score - a.quality_score ||
      successRate(b) - successRate(a),
    smart_balanced: (a, b) =>
      Number(b.is_free) - Number(a.is_free) ||
      successRate(b) - successRate(a) ||
      b.quality_score - a.quality_score ||
      providerPriority(a) - providerPriority(b),
    lowest_cost: (a, b) => totalCost(a) - totalCost(b) || b.quality_score - a.quality_score,
    best_quality: (a, b) => b.quality_score - a.quality_score || successRate(b) - successRate(a),
    fastest: (a, b) => (a.avg_latency_ms ?? 99999) - (b.avg_latency_ms ?? 99999) || b.quality_score - a.quality_score,
  };

  const sorted = [...pool].sort((a, b) => comparators[policy](a, b) || preferenceScore(b) - preferenceScore(a));
  const firstByProvider: CandidateModel[] = [];
  for (const candidate of sorted) {
    if (!firstByProvider.some((item) => item.provider_key === candidate.provider_key)) firstByProvider.push(candidate);
  }
  const diversified = [...firstByProvider];
  for (const candidate of sorted) if (!diversified.includes(candidate)) diversified.push(candidate);
  return diversified;
}

async function loadPolicy(supabase: SupabaseClient): Promise<{ policy: RoutingPolicy; allowPaidFallback: boolean }> {
  const { data } = await supabase.from('ai_routing_policy').select('policy, allow_paid_fallback').eq('id', true).maybeSingle();
  return {
    policy: (data?.policy as RoutingPolicy) ?? 'smart_balanced',
    allowPaidFallback: data?.allow_paid_fallback ?? true,
  };
}

async function recordHealth(
  supabase: SupabaseClient,
  providerKey: string,
  modelId: string,
  ok: boolean,
  latencyMs: number,
  errorMsg?: string
) {
  const { data: row } = await supabase
    .from('ai_models')
    .select('success_count, failure_count, consecutive_failures, avg_latency_ms')
    .eq('provider_key', providerKey)
    .eq('model_id', modelId)
    .maybeSingle();
  if (!row) return;

  const patch: Record<string, unknown> = {};
  if (ok) {
    patch.success_count = row.success_count + 1;
    patch.consecutive_failures = 0;
    patch.circuit_state = 'closed';
    patch.circuit_opened_at = null;
    patch.status = 'healthy';
    patch.last_success_at = new Date().toISOString();
    patch.avg_latency_ms = row.avg_latency_ms ? Math.round((row.avg_latency_ms + latencyMs) / 2) : latencyMs;
  } else {
    const consecutive = (row.consecutive_failures ?? 0) + 1;
    patch.failure_count = row.failure_count + 1;
    patch.consecutive_failures = consecutive;
    patch.last_failure_at = new Date().toISOString();
    patch.last_error = errorMsg?.slice(0, 300) ?? null;
    patch.status = consecutive >= CONSECUTIVE_FAILURES_TO_OPEN ? 'disabled' : consecutive >= 3 ? 'degraded' : 'healthy';
    if (consecutive >= CONSECUTIVE_FAILURES_TO_OPEN) {
      patch.circuit_state = 'open';
      patch.circuit_opened_at = new Date().toISOString();
    }
  }

  await supabase.from('ai_models').update(patch).eq('provider_key', providerKey).eq('model_id', modelId);
}

/**
 * Runs a chat task against the best available model, failing over to the
 * next-ranked candidate on any failover-eligible error, until one succeeds
 * or the fallback chain is exhausted (spec items 9, 11, 21).
 */
export async function routeAndRun(
  supabase: SupabaseClient,
  req: CapabilityRequest & { systemPrompt: string; userPrompt: string; jsonMode: boolean; validate?: (content: string) => boolean; webSearchOptions?: { maxResults?: number; includeDomains?: string[]; excludeDomains?: string[] } | null }
): Promise<RunResult> {
  const [{ candidates, providers }, { policy, allowPaidFallback }] = await Promise.all([
    loadCandidates(supabase, req.requiredCapabilities),
    loadPolicy(supabase),
  ]);

  const ranked = rankCandidates(candidates, providers, policy, allowPaidFallback, req.preferredCapabilities ?? []).slice(0, MAX_ATTEMPTS);
  if (ranked.length === 0) throw new NoModelAvailableError();

  const fallbackLog: RunResult['fallbackLog'] = [];

  for (const candidate of ranked) {
    const adapter = getAdapter(candidate.provider_key);
    if (!adapter) continue;

    const apiKeyRes = await supabase
      .from('ai_provider_secrets')
      .select('api_key')
      .eq('provider_key', candidate.provider_key)
      .maybeSingle();
    const apiKey = apiKeyRes.data?.api_key;
    if (!apiKey) continue;

    const started = Date.now();
    try {
      const result: ChatResult = await adapter.chatComplete(
        apiKey,
        candidate.model_id,
        req.systemPrompt,
        req.userPrompt,
        req.jsonMode,
        undefined,
        req.webSearchOptions ?? undefined
      );

      if (req.validate && !req.validate(result.content)) {
        throw new Error('Structured output validation failed');
      }

      const latencyMs = Date.now() - started;
      await recordHealth(supabase, candidate.provider_key, candidate.model_id, true, latencyMs);

      return {
        content: result.content,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        providerUsed: candidate.provider_key,
        modelUsed: candidate.model_id,
        fallbackCount: fallbackLog.length,
        fallbackLog,
        citations: result.citations,
      };
    } catch (err) {
      const latencyMs = Date.now() - started;
      const message = err instanceof Error ? err.message : 'Unknown provider error';
      await recordHealth(supabase, candidate.provider_key, candidate.model_id, false, latencyMs, message);
      fallbackLog.push({ provider: candidate.provider_key, model: candidate.model_id, error: message });

      // Non-failover errors (bad request / invalid schema / content policy)
      // stop the chain immediately instead of burning through every model.
      if (err instanceof ProviderCallError && !FAILOVER_STATUSES.has(err.status) && err.status < 500 && err.status !== 429) {
        throw new NonFailoverError(message);
      }
      if (!isFailoverEligible(err)) throw new NonFailoverError(message);
      // otherwise: continue to next candidate
    }
  }

  throw new NoModelAvailableError();
}
