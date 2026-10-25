import { summarizeTaskPerformance } from '../_shared/execution-metrics.ts';
import { loadRoutingReadiness } from '../ai-gateway/router.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import { getAdapter, computeQualityScore, type ProviderKey, PROVIDER_CATALOG } from './providers.ts';

// ---------------------------------------------------------------------------
// AI Control Center backend. Every action here requires the caller to be a
// platform Super Admin — checked against the database (is_super_admin()),
// not just "hidden from the menu". A non-super-admin hitting this endpoint
// directly gets a real 403, same as the RLS policies on the tables do.
// ---------------------------------------------------------------------------

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } }
);

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

async function requireSuperAdmin(req: Request): Promise<{ ok: true; userId: string } | { ok: false; response: Response }> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return { ok: false, response: jsonRes(401, { error: 'Missing authentication token' }) };

  const { data: userData, error } = await supabase.auth.getUser(token);
  if (error || !userData.user) return { ok: false, response: jsonRes(401, { error: 'Invalid or expired token' }) };

  // The DB helper enforces auth.uid(), which is unavailable when this
  // service-role client validates a user token. Check the protected table
  // directly so a real platform admin is not rejected by the service-role hop.
  const { data: adminRow, error: adminError } = await supabase.from('platform_admins').select('user_id').eq('user_id', userData.user.id).maybeSingle();
  if (adminError) return { ok: false, response: jsonRes(500, { error: 'Unable to verify Super Admin permissions' }) };
  if (!adminRow) return { ok: false, response: jsonRes(403, { error: 'Forbidden — Super Admin only' }) };

  return { ok: true, userId: userData.user.id };
}

const VALID_PROVIDER_KEYS = new Set(Object.keys(PROVIDER_CATALOG));

type Action =
  | { action: 'list_providers' }
  | { action: 'list_models'; providerKey?: string }
  | { action: 'get_routing_policy' }
  | { action: 'get_usage_summary' }
  | { action: 'add_provider'; providerKey: ProviderKey; apiKey: string; baseUrl?: string }
  | { action: 'test_connection'; providerKey: ProviderKey }
  | { action: 'discover_models'; providerKey: ProviderKey }
  | { action: 'set_enabled'; providerKey: ProviderKey; enabled: boolean }
  | { action: 'set_priority'; providerKey: ProviderKey; priority: number }
  | { action: 'set_allow_paid'; providerKey: ProviderKey; allowPaid: boolean }
  | { action: 'remove_provider'; providerKey: ProviderKey }
  | { action: 'set_routing_policy'; policy: string; allowPaidFallback: boolean };

async function getApiKey(providerKey: string): Promise<string | null> {
  const { data } = await supabase.from('ai_provider_secrets').select('api_key').eq('provider_key', providerKey).maybeSingle();
  return data?.api_key ?? null;
}

async function handleAddProvider(body: Extract<Action, { action: 'add_provider' }>) {
  if (!VALID_PROVIDER_KEYS.has(body.providerKey)) return jsonRes(400, { error: 'Unknown provider' });
  if (!body.apiKey || body.apiKey.trim().length < 4) return jsonRes(400, { error: 'API key is required' });

  await supabase.from('ai_provider_secrets').upsert({
    provider_key: body.providerKey,
    api_key: body.apiKey.trim(),
    updated_at: new Date().toISOString(),
  });

  await supabase.from('ai_providers').update({
    has_api_key: true,
    base_url: body.baseUrl?.trim() || null,
    status: 'not_configured',
    last_test_at: null,
    last_test_ok: null,
    last_error: null,
  }).eq('provider_key', body.providerKey);

  return jsonRes(200, { ok: true });
}

async function handleTestConnection(body: Extract<Action, { action: 'test_connection' }>) {
  const adapter = getAdapter(body.providerKey);
  if (!adapter) return jsonRes(400, { error: 'Unknown provider' });

  const apiKey = await getApiKey(body.providerKey);
  if (!apiKey) return jsonRes(400, { error: 'أضف API Key أولًا' });

  const { data: providerRow } = await supabase.from('ai_providers').select('base_url').eq('provider_key', body.providerKey).maybeSingle();
  const result = await adapter.testConnection(apiKey, providerRow?.base_url ?? null);

  await supabase.from('ai_providers').update({
    status: result.ok ? 'connected' : 'error',
    last_test_at: new Date().toISOString(),
    last_test_ok: result.ok,
    last_error: result.ok ? null : result.error ?? 'Unknown error',
  }).eq('provider_key', body.providerKey);

  return jsonRes(200, result);
}

async function handleDiscoverModels(body: Extract<Action, { action: 'discover_models' }>) {
  const adapter = getAdapter(body.providerKey);
  if (!adapter) return jsonRes(400, { error: 'Unknown provider' });

  const apiKey = await getApiKey(body.providerKey);
  if (!apiKey) return jsonRes(400, { error: 'أضف API Key أولًا' });

  const { data: providerRow } = await supabase.from('ai_providers').select('base_url').eq('provider_key', body.providerKey).maybeSingle();

  let discovered;
  try {
    discovered = await adapter.discoverModels(apiKey, providerRow?.base_url ?? null);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Discovery failed';
    await supabase.from('ai_providers').update({ status: 'error', last_error: message }).eq('provider_key', body.providerKey);
    return jsonRes(502, { error: message });
  }

  const rows = discovered.map((m) => ({
    provider_key: body.providerKey,
    model_id: m.model_id,
    display_name: m.display_name,
    capabilities: [
      'text_generation',
      ...(m.vision ? ['vision'] : []),
      ...(m.reasoning ? ['reasoning'] : []),
      ...(m.tool_calling ? ['tool_calling'] : []),
      ...(m.structured_output ? ['structured_output'] : []),
    ],
    context_window: m.context_window,
    max_output_tokens: m.max_output_tokens,
    vision: m.vision,
    reasoning: m.reasoning,
    tool_calling: m.tool_calling,
    structured_output: m.structured_output,
    audio: m.audio,
    image: m.image,
    embedding: m.embedding,
    is_free: m.is_free,
    input_cost_per_1k: m.input_cost_per_1k,
    output_cost_per_1k: m.output_cost_per_1k,
    quality_score: computeQualityScore(m),
    status: 'healthy',
    discovered_at: new Date().toISOString(),
  }));

  if (rows.length > 0) {
    await supabase.from('ai_models').upsert(rows, { onConflict: 'provider_key,model_id' });
  }

  const { count: modelsCount } = await supabase
    .from('ai_models')
    .select('*', { count: 'exact', head: true })
    .eq('provider_key', body.providerKey);
  const { count: healthyCount } = await supabase
    .from('ai_models')
    .select('*', { count: 'exact', head: true })
    .eq('provider_key', body.providerKey)
    .eq('status', 'healthy');

  await supabase.from('ai_providers').update({
    status: 'connected',
    enabled: true,
    models_count: modelsCount ?? rows.length,
    healthy_models_count: healthyCount ?? rows.length,
  }).eq('provider_key', body.providerKey);

  return jsonRes(200, { ok: true, modelsDiscovered: rows.length });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'POST') return jsonRes(405, { error: 'Method not allowed' });

  const auth = await requireSuperAdmin(req);
  if (!auth.ok) return auth.response;

  let body: Action;
  try {
    body = await req.json();
  } catch {
    return jsonRes(400, { error: 'Invalid JSON body' });
  }

  try {
    switch (body.action) {
      case 'list_providers': {
        const providerNames: Record<string, string> = {
          openrouter: 'OpenRouter',
          huggingface: 'Hugging Face',
          groq: 'Groq',
          gemini: 'Google Gemini',
          cerebras: 'Cerebras',
          deepseek: 'DeepSeek',
          together: 'Together AI',
          fireworks: 'Fireworks AI',
          mistral: 'Mistral',
          anthropic: 'Anthropic Claude',
          xai: 'xAI Grok',
          cohere: 'Cohere',
          openai: 'OpenAI',
        };
        const [{ data, error }, readiness] = await Promise.all([
          supabase.from('ai_providers').select('*').order('priority', { ascending: true }),
          loadRoutingReadiness(supabase),
        ]);
        if (error) throw error;
        const rows = (data ?? []) as Array<Record<string, unknown>>;
        const byKey = new Map(rows.map((row) => [String(row.provider_key), row]));
        const providers = Object.entries(PROVIDER_CATALOG).map(([key, catalog], index) => {
          const row = byKey.get(key) ?? {};
          const status = row.status === 'connected' || row.status === 'error' ? row.status : 'not_configured';
          return {
            id: String(row.id ?? `catalog-${key}`),
            provider_key: key,
            display_name: String(row.display_name ?? providerNames[key] ?? key),
            enabled: Boolean(row.enabled ?? false),
            has_api_key: Boolean(row.has_api_key ?? false),
            base_url: (row.base_url as string | null | undefined) ?? catalog.defaultBaseUrl,
            priority: Number(row.priority ?? index + 1),
            failover_enabled: Boolean(row.failover_enabled ?? true),
            allow_paid: Boolean(row.allow_paid ?? true),
            status,
            last_test_at: (row.last_test_at as string | null | undefined) ?? null,
            last_test_ok: (row.last_test_ok as boolean | null | undefined) ?? null,
            last_error: (row.last_error as string | null | undefined) ?? null,
            models_count: Number(row.models_count ?? 0),
            healthy_models_count: Number(row.healthy_models_count ?? 0),
            routing_readiness: row.enabled && row.has_api_key ? (readiness[key] ?? { native_json: 0, validated_json: 0 }) : { native_json: 0, validated_json: 0 },
          };
        });
        return jsonRes(200, { providers });
      }

      case 'list_models': {
        let query = supabase.from('ai_models').select('*').order('provider_key').order('quality_score', { ascending: false });
        if (body.providerKey) query = query.eq('provider_key', body.providerKey);
        const { data } = await query;
        return jsonRes(200, { models: data ?? [] });
      }

      case 'get_routing_policy': {
        const { data } = await supabase.from('ai_routing_policy').select('*').eq('id', true).maybeSingle();
        return jsonRes(200, { policy: data });
      }

      case 'get_usage_summary': {
        const [usageRead,performanceRead]=await Promise.all([
          supabase.from('ai_runs').select('provider, model, status, cost_usd, input_tokens, output_tokens, fallback_count, created_at').order('created_at',{ascending:false}).limit(200),
          supabase.from('assistant_tasks').select('status,created_at,started_at,completed_at,progress').in('task_kind',['create','agent']).eq('status','completed').order('created_at',{ascending:false}).limit(200).abortSignal(AbortSignal.timeout(10_000)),
        ]);
        const {data,error:usageError}=usageRead;
        if(usageError)throw usageError;
        const {data:taskRows,error:taskError}=performanceRead;
        const rows = data ?? [];
        const totals = rows.reduce(
          (acc, r) => {
            acc.requests += 1;
            acc.tokens += (r.input_tokens ?? 0) + (r.output_tokens ?? 0);
            acc.cost += Math.max(0, Number(r.cost_usd ?? 0));
            acc.fallbacks += r.fallback_count ?? 0;
            if (r.status === 'failed') acc.failures += 1;
            return acc;
          },
          { requests: 0, tokens: 0, cost: 0, fallbacks: 0, failures: 0 }
        );
        return jsonRes(200, {
          totals,
          performance:taskError?null:summarizeTaskPerformance(taskRows??[]),
          performance_unavailable:Boolean(taskError),
          recent: rows.slice(0, 30).map((r) => ({ ...r, cost_usd: Math.max(0, Number(r.cost_usd ?? 0)) })),
        });
      }

      case 'add_provider':
        return await handleAddProvider(body);

      case 'test_connection':
        return await handleTestConnection(body);

      case 'discover_models':
        return await handleDiscoverModels(body);

      case 'set_enabled': {
        await supabase.from('ai_providers').update({ enabled: body.enabled }).eq('provider_key', body.providerKey);
        return jsonRes(200, { ok: true });
      }

      case 'set_priority': {
        await supabase.from('ai_providers').update({ priority: body.priority }).eq('provider_key', body.providerKey);
        return jsonRes(200, { ok: true });
      }

      case 'set_allow_paid': {
        await supabase.from('ai_providers').update({ allow_paid: body.allowPaid }).eq('provider_key', body.providerKey);
        return jsonRes(200, { ok: true });
      }

      case 'remove_provider': {
        await supabase.from('ai_provider_secrets').delete().eq('provider_key', body.providerKey);
        await supabase.from('ai_models').delete().eq('provider_key', body.providerKey);
        await supabase.from('ai_providers').update({
          enabled: false,
          has_api_key: false,
          status: 'not_configured',
          models_count: 0,
          healthy_models_count: 0,
          last_test_at: null,
          last_test_ok: null,
          last_error: null,
        }).eq('provider_key', body.providerKey);
        return jsonRes(200, { ok: true });
      }

      case 'set_routing_policy': {
        await supabase.from('ai_routing_policy').update({
          policy: body.policy,
          allow_paid_fallback: body.allowPaidFallback,
          updated_at: new Date().toISOString(),
        }).eq('id', true);
        return jsonRes(200, { ok: true });
      }

      default:
        return jsonRes(400, { error: 'Unknown action' });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return jsonRes(500, { error: message });
  }
});
