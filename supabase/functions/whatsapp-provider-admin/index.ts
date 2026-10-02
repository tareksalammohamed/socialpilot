import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } },
);

type ProviderKey = 'evolution' | 'waha' | 'wppconnect';

type ProviderConfig = {
  provider_key: ProviderKey;
  display_name: string;
  base_url: string | null;
  enabled: boolean;
  priority: number;
  status: 'not_configured' | 'connected' | 'error';
  capabilities: Record<string, unknown>;
  last_error: string | null;
  last_test_at: string | null;
};

type Action =
  | { action: 'list' }
  | { action: 'save'; providerKey: ProviderKey; baseUrl: string; secret?: string; priority?: number }
  | { action: 'test'; providerKey: ProviderKey }
  | { action: 'set_enabled'; providerKey: ProviderKey; enabled: boolean }
  | { action: 'remove'; providerKey: ProviderKey };

const VALID_PROVIDERS = new Set<ProviderKey>(['evolution', 'waha', 'wppconnect']);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function normalizeUrl(value: string): string {
  const parsed = new URL(value.trim());
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Base URL غير صالح');
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

async function requireSuperAdmin(req: Request): Promise<string | null> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data: auth } = await supabase.auth.getUser(token);
  if (!auth.user) return null;
  const { data: admin } = await supabase
    .from('platform_admins')
    .select('user_id')
    .eq('user_id', auth.user.id)
    .maybeSingle();
  return admin ? auth.user.id : null;
}

async function providerSecret(providerKey: ProviderKey): Promise<string | null> {
  const { data } = await supabase
    .from('whatsapp_provider_secrets')
    .select('primary_secret')
    .eq('provider_key', providerKey)
    .maybeSingle();
  return typeof data?.primary_secret === 'string' ? data.primary_secret : null;
}

async function testEvolution(baseUrl: string, secret: string): Promise<void> {
  const response = await fetch(`${baseUrl}/instance/fetchInstances`, {
    headers: { apikey: secret },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    const nested = body.response as Record<string, unknown> | undefined;
    const message = nested?.message ?? body.message ?? body.error;
    throw new Error(typeof message === 'string' ? message : `Evolution HTTP ${response.status}`);
  }
}

async function testWaha(baseUrl: string, secret: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/sessions`, {
    headers: { 'X-Api-Key': secret, Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    const message = body.message ?? body.error;
    throw new Error(typeof message === 'string' ? message : `WAHA HTTP ${response.status}`);
  }
}

async function testWppconnect(baseUrl: string, secret: string): Promise<void> {
  // Validate both server reachability and SECRET_KEY, not just /healthz.
  const health = await fetch(`${baseUrl}/healthz`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!health.ok) throw new Error(`WPPConnect health HTTP ${health.status}`);

  const probeSession = 'socialpilot_health_probe';
  const response = await fetch(
    `${baseUrl}/api/${probeSession}/${encodeURIComponent(secret)}/generate-token`,
    {
      method: 'POST',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    },
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    const message = body.message ?? body.error;
    throw new Error(typeof message === 'string' ? message : `WPPConnect auth HTTP ${response.status}`);
  }
}

async function testProvider(providerKey: ProviderKey, baseUrl: string, secret: string): Promise<void> {
  if (providerKey === 'evolution') return testEvolution(baseUrl, secret);
  if (providerKey === 'waha') return testWaha(baseUrl, secret);
  return testWppconnect(baseUrl, secret);
}

async function syncPlatformAggregate(): Promise<void> {
  const { data: providers } = await supabase
    .from('whatsapp_provider_configs')
    .select('provider_key,enabled,status,last_error')
    .order('priority');

  const healthy = (providers ?? []).filter((row) => row.enabled && row.status === 'connected');
  const configured = (providers ?? []).some((row) => row.status !== 'not_configured');
  const errors = (providers ?? [])
    .filter((row) => row.status === 'error' && row.last_error)
    .map((row) => `${row.provider_key}: ${row.last_error}`);

  await supabase.from('social_platform_apps').update({
    display_name: 'واتساب',
    enabled: healthy.length > 0,
    has_secret: configured,
    status: healthy.length > 0 ? 'connected' : configured ? 'error' : 'not_configured',
    last_error: healthy.length > 0 ? null : errors[0] ?? null,
    last_test_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('platform_key', 'whatsapp');
}

async function listProviders(): Promise<Array<ProviderConfig & { has_secret: boolean }>> {
  const [{ data: configs, error }, { data: secrets }] = await Promise.all([
    supabase.from('whatsapp_provider_configs').select('*').order('priority').order('provider_key'),
    supabase.from('whatsapp_provider_secrets').select('provider_key'),
  ]);
  if (error) throw error;
  const secretKeys = new Set((secrets ?? []).map((row) => row.provider_key));
  return (configs ?? []).map((row) => ({
    ...(row as ProviderConfig),
    has_secret: secretKeys.has(row.provider_key),
    configured: Boolean(row.base_url && secretKeys.has(row.provider_key)),
  }));
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const adminId = await requireSuperAdmin(req);
  if (!adminId) return json(403, { error: 'Forbidden — Super Admin only' });

  let body: Action;
  try {
    body = await req.json() as Action;
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  try {
    if (body.action === 'list') {
      return json(200, { providers: await listProviders() });
    }

    if (!VALID_PROVIDERS.has(body.providerKey)) {
      return json(400, { error: 'مزود WhatsApp غير معروف' });
    }

    if (body.action === 'remove') {
      await supabase.from('whatsapp_provider_secrets').delete().eq('provider_key', body.providerKey);
      await supabase.from('whatsapp_provider_configs').update({
        base_url: null,
        enabled: false,
        status: 'not_configured',
        last_error: null,
        last_test_at: null,
        updated_at: new Date().toISOString(),
      }).eq('provider_key', body.providerKey);
      await syncPlatformAggregate();
      return json(200, { ok: true, providers: await listProviders() });
    }

    if (body.action === 'set_enabled') {
      const { data: provider } = await supabase
        .from('whatsapp_provider_configs')
        .select('status')
        .eq('provider_key', body.providerKey)
        .maybeSingle();
      if (!provider || provider.status !== 'connected') {
        return json(409, { error: 'لا يمكن تفعيل مزود قبل نجاح Health Check' });
      }
      await supabase.from('whatsapp_provider_configs').update({
        enabled: body.enabled,
        updated_at: new Date().toISOString(),
      }).eq('provider_key', body.providerKey);
      await syncPlatformAggregate();
      return json(200, { ok: true, providers: await listProviders() });
    }

    const { data: current } = await supabase
      .from('whatsapp_provider_configs')
      .select('*')
      .eq('provider_key', body.providerKey)
      .maybeSingle();
    if (!current) return json(404, { error: 'Provider config missing' });

    if (body.action === 'save') {
      const baseUrl = normalizeUrl(body.baseUrl);
      if (body.secret?.trim()) {
        await supabase.from('whatsapp_provider_secrets').upsert({
          provider_key: body.providerKey,
          primary_secret: body.secret.trim(),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'provider_key' });
      }
      const secret = body.secret?.trim() || await providerSecret(body.providerKey);
      if (!secret) {
        await supabase.from('whatsapp_provider_configs').update({
          base_url: baseUrl,
          enabled: false,
          status: 'not_configured',
          last_error: 'Secret / API Key مطلوب',
          priority: Math.max(1, Math.min(999, Math.round(body.priority ?? current.priority ?? 100))),
          updated_at: new Date().toISOString(),
        }).eq('provider_key', body.providerKey);
        await syncPlatformAggregate();
        return json(400, { error: 'Secret / API Key مطلوب' });
      }

      try {
        await testProvider(body.providerKey, baseUrl, secret);
        await supabase.from('whatsapp_provider_configs').update({
          base_url: baseUrl,
          enabled: true,
          status: 'connected',
          last_error: null,
          last_test_at: new Date().toISOString(),
          priority: Math.max(1, Math.min(999, Math.round(body.priority ?? current.priority ?? 100))),
          updated_at: new Date().toISOString(),
        }).eq('provider_key', body.providerKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Provider health check failed';
        await supabase.from('whatsapp_provider_configs').update({
          base_url: baseUrl,
          enabled: false,
          status: 'error',
          last_error: message,
          last_test_at: new Date().toISOString(),
          priority: Math.max(1, Math.min(999, Math.round(body.priority ?? current.priority ?? 100))),
          updated_at: new Date().toISOString(),
        }).eq('provider_key', body.providerKey);
        await syncPlatformAggregate();
        return json(502, { error: message, providers: await listProviders() });
      }

      await syncPlatformAggregate();
      return json(200, { ok: true, providers: await listProviders() });
    }

    if (body.action === 'test') {
      if (!current.base_url) return json(409, { error: 'Base URL غير موجود' });
      const secret = await providerSecret(body.providerKey);
      if (!secret) return json(409, { error: 'Secret / API Key غير موجود' });
      try {
        await testProvider(body.providerKey, normalizeUrl(current.base_url), secret);
        await supabase.from('whatsapp_provider_configs').update({
          status: 'connected',
          last_error: null,
          last_test_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('provider_key', body.providerKey);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Provider health check failed';
        await supabase.from('whatsapp_provider_configs').update({
          status: 'error',
          enabled: false,
          last_error: message,
          last_test_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('provider_key', body.providerKey);
        await syncPlatformAggregate();
        return json(502, { error: message, providers: await listProviders() });
      }
      await syncPlatformAggregate();
      return json(200, { ok: true, providers: await listProviders() });
    }

    return json(400, { error: 'Unknown action' });
  } catch (error) {
    return json(500, { error: error instanceof Error ? error.message : 'Internal error' });
  }
});
