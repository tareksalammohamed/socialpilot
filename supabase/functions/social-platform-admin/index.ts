import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } },
);

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function requireSuperAdmin(req: Request): Promise<{ ok: true; userId: string } | { ok: false; response: Response }> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return { ok: false, response: jsonRes(401, { error: 'Missing authentication token' }) };

  const { data: userData, error } = await supabase.auth.getUser(token);
  if (error || !userData.user) return { ok: false, response: jsonRes(401, { error: 'Invalid or expired token' }) };

  const { data: adminRow, error: adminError } = await supabase
    .from('platform_admins')
    .select('user_id')
    .eq('user_id', userData.user.id)
    .maybeSingle();

  if (adminError) return { ok: false, response: jsonRes(500, { error: 'Unable to verify Super Admin permissions' }) };
  if (!adminRow) return { ok: false, response: jsonRes(403, { error: 'Forbidden — Super Admin only' }) };
  return { ok: true, userId: userData.user.id };
}

const VALID_PLATFORM_KEYS = new Set(['meta', 'linkedin', 'telegram', 'x', 'threads', 'tiktok', 'whatsapp']);
const REDIRECT_URI_PLATFORMS = new Set(['meta', 'linkedin', 'x', 'threads', 'tiktok']);

type WhatsAppProviderKey = 'evolution' | 'waha' | 'wppconnect';
type WhatsAppProviderStatus = 'not_configured' | 'connected' | 'error';

type WhatsAppProviderSecretConfig = {
  baseUrl: string;
  credential: string;
  enabled: boolean;
  priority: number;
  status: WhatsAppProviderStatus;
  lastError: string | null;
  lastTestAt: string | null;
};

type WhatsAppProviderBundle = {
  version: 1;
  activeProvider: WhatsAppProviderKey | null;
  providers: Partial<Record<WhatsAppProviderKey, WhatsAppProviderSecretConfig>>;
};

const WHATSAPP_PROVIDER_KEYS: WhatsAppProviderKey[] = ['evolution', 'waha', 'wppconnect'];
const PROVIDER_LABELS: Record<WhatsAppProviderKey, string> = {
  evolution: 'Evolution / Baileys',
  waha: 'WAHA',
  wppconnect: 'WPPConnect',
};

function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value.trim());
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Provider Base URL غير صالح');
  return parsed.toString().replace(/\/$/, '');
}

function parseWhatsAppBundle(secretValue: unknown, legacyBaseUrl?: unknown): WhatsAppProviderBundle {
  const raw = typeof secretValue === 'string' ? secretValue.trim() : '';
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as WhatsAppProviderBundle;
      if (parsed?.version === 1 && parsed.providers && typeof parsed.providers === 'object') {
        return {
          version: 1,
          activeProvider: WHATSAPP_PROVIDER_KEYS.includes(parsed.activeProvider as WhatsAppProviderKey)
            ? parsed.activeProvider
            : null,
          providers: parsed.providers,
        };
      }
    } catch {
      // Legacy secret falls through below.
    }
  }

  const legacyUrl = typeof legacyBaseUrl === 'string' && /^https?:\/\//i.test(legacyBaseUrl)
    ? legacyBaseUrl.trim().replace(/\/+$/, '')
    : '';
  if (raw && legacyUrl) {
    return {
      version: 1,
      activeProvider: 'evolution',
      providers: {
        evolution: {
          baseUrl: legacyUrl,
          credential: raw,
          enabled: true,
          priority: 10,
          status: 'connected',
          lastError: null,
          lastTestAt: null,
        },
      },
    };
  }

  return { version: 1, activeProvider: null, providers: {} };
}

async function readWhatsAppBundle(): Promise<{
  app: Record<string, unknown> | null;
  bundle: WhatsAppProviderBundle;
}> {
  const [{ data: app }, { data: secret }] = await Promise.all([
    supabase.from('social_platform_apps').select('*').eq('platform_key', 'whatsapp').maybeSingle(),
    supabase.from('social_platform_app_secrets').select('app_secret').eq('platform_key', 'whatsapp').maybeSingle(),
  ]);
  return {
    app: (app as Record<string, unknown> | null) ?? null,
    bundle: parseWhatsAppBundle(secret?.app_secret, app?.app_id),
  };
}

function publicProviderConfig(key: WhatsAppProviderKey, config: WhatsAppProviderSecretConfig | undefined) {
  return {
    provider_key: key,
    display_name: PROVIDER_LABELS[key],
    base_url: config?.baseUrl ?? null,
    enabled: config?.enabled ?? false,
    priority: config?.priority ?? (key === 'evolution' ? 10 : key === 'waha' ? 20 : 30),
    configured: Boolean(config?.baseUrl && config?.credential),
    has_secret: Boolean(config?.credential),
    status: config?.status ?? 'not_configured',
    last_error: config?.lastError ?? null,
    last_test_at: config?.lastTestAt ?? null,
  };
}

async function testEvolution(baseUrl: string, apiKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(`${baseUrl}/instance/fetchInstances`, {
      headers: { apikey: apiKey },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      const nested = body.response as Record<string, unknown> | undefined;
      const message = nested?.message ?? body.message ?? body.error;
      return { ok: false, error: typeof message === 'string' ? message : `Evolution HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'تعذّر الوصول إلى Evolution API' };
  }
}

async function testWaha(baseUrl: string, apiKey: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await fetch(`${baseUrl}/api/sessions?all=true`, {
      headers: { 'X-Api-Key': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      const message = body.message ?? body.error;
      return { ok: false, error: typeof message === 'string' ? message : `WAHA HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'تعذّر الوصول إلى WAHA' };
  }
}

async function testWppConnect(baseUrl: string, secretKey: string): Promise<{ ok: boolean; error?: string }> {
  const healthSession = 'socialpilot_health';
  try {
    const response = await fetch(
      `${baseUrl}/api/${encodeURIComponent(healthSession)}/${encodeURIComponent(secretKey)}/generate-token`,
      { method: 'POST', signal: AbortSignal.timeout(8000) },
    );
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || (typeof body.full !== 'string' && typeof body.token !== 'string')) {
      const message = body.message ?? body.error ?? body.status;
      return { ok: false, error: typeof message === 'string' ? message : `WPPConnect HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'تعذّر الوصول إلى WPPConnect' };
  }
}

async function testWhatsAppProvider(
  provider: WhatsAppProviderKey,
  baseUrl: string,
  credential: string,
): Promise<{ ok: boolean; error?: string }> {
  if (provider === 'evolution') return testEvolution(baseUrl, credential);
  if (provider === 'waha') return testWaha(baseUrl, credential);
  return testWppConnect(baseUrl, credential);
}

function chooseActiveProvider(bundle: WhatsAppProviderBundle): WhatsAppProviderKey | null {
  const current = bundle.activeProvider;
  if (current) {
    const config = bundle.providers[current];
    if (config?.enabled && config.status === 'connected') return current;
  }

  return WHATSAPP_PROVIDER_KEYS
    .map((key) => ({ key, config: bundle.providers[key] }))
    .filter((item) => item.config?.enabled && item.config.status === 'connected')
    .sort((a, b) => (a.config?.priority ?? 999) - (b.config?.priority ?? 999))[0]?.key ?? null;
}

async function persistWhatsAppBundle(bundle: WhatsAppProviderBundle): Promise<void> {
  bundle.activeProvider = chooseActiveProvider(bundle);
  const configs = Object.values(bundle.providers).filter(Boolean) as WhatsAppProviderSecretConfig[];
  const healthy = configs.filter((config) => config.enabled && config.status === 'connected');
  const configured = configs.filter((config) => config.baseUrl && config.credential);
  const enabled = healthy.length > 0;
  const errors = configs
    .filter((config) => config.enabled && config.status === 'error' && config.lastError)
    .sort((a, b) => a.priority - b.priority)
    .map((config) => config.lastError as string);

  await supabase.from('social_platform_app_secrets').upsert({
    platform_key: 'whatsapp',
    app_secret: JSON.stringify(bundle),
    updated_at: new Date().toISOString(),
  });

  await supabase.from('social_platform_apps').update({
    app_id: bundle.activeProvider,
    redirect_uri: null,
    has_secret: configured.length > 0,
    enabled,
    status: enabled ? 'connected' : configured.length > 0 ? 'error' : 'not_configured',
    last_test_at: configs.some((config) => config.lastTestAt) ? new Date().toISOString() : null,
    last_error: enabled ? null : errors[0] ?? (configured.length > 0 ? 'لا يوجد WhatsApp Provider سليم ومفعّل' : null),
    updated_at: new Date().toISOString(),
  }).eq('platform_key', 'whatsapp');
}

type Action =
  | { action: 'list_apps' }
  | { action: 'save_app'; platformKey: string; appId: string; appSecret?: string; redirectUri?: string; configurationId?: string }
  | { action: 'set_enabled'; platformKey: string; enabled: boolean }
  | { action: 'remove_app'; platformKey: string }
  | {
      action: 'save_whatsapp_provider';
      providerKey: WhatsAppProviderKey;
      baseUrl: string;
      credential?: string;
      enabled?: boolean;
      priority?: number;
    }
  | { action: 'test_whatsapp_providers' }
  | { action: 'set_whatsapp_provider_enabled'; providerKey: WhatsAppProviderKey; enabled: boolean }
  | { action: 'set_whatsapp_active_provider'; providerKey: WhatsAppProviderKey }
  | { action: 'remove_whatsapp_provider'; providerKey: WhatsAppProviderKey };

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
      case 'list_apps': {
        const [{ data, error }, { data: embeddedSetting }, whatsapp] = await Promise.all([
          supabase.from('social_platform_apps').select('*').order('platform_key'),
          supabase.from('system_settings').select('value').eq('key', 'social.meta.whatsapp_embedded_signup').maybeSingle(),
          readWhatsAppBundle(),
        ]);
        if (error) return jsonRes(500, { error: error.message });

        const embedded = (embeddedSetting?.value ?? {}) as Record<string, unknown>;
        const apps = (data ?? []).map((app) => {
          if (app.platform_key === 'meta') {
            return {
              ...app,
              configuration_id: typeof embedded.configuration_id === 'string' ? embedded.configuration_id : null,
            };
          }
          if (app.platform_key === 'whatsapp') {
            return {
              ...app,
              active_provider: chooseActiveProvider(whatsapp.bundle),
              whatsapp_providers: WHATSAPP_PROVIDER_KEYS.map((key) => publicProviderConfig(key, whatsapp.bundle.providers[key])),
            };
          }
          return app;
        });
        return jsonRes(200, { apps });
      }

      case 'save_whatsapp_provider': {
        if (!WHATSAPP_PROVIDER_KEYS.includes(body.providerKey)) return jsonRes(400, { error: 'Unknown WhatsApp provider' });
        const baseUrl = normalizeBaseUrl(body.baseUrl);
        const { bundle } = await readWhatsAppBundle();
        const previous = bundle.providers[body.providerKey];
        const credential = body.credential?.trim() || previous?.credential || '';
        if (!credential) return jsonRes(400, { error: 'API Key / Secret Key مطلوب للمزود' });

        const testedAt = new Date().toISOString();
        const health = await testWhatsAppProvider(body.providerKey, baseUrl, credential);
        bundle.providers[body.providerKey] = {
          baseUrl,
          credential,
          enabled: body.enabled ?? previous?.enabled ?? true,
          priority: Math.max(1, Math.min(100, Math.round(body.priority ?? previous?.priority ?? (
            body.providerKey === 'evolution' ? 10 : body.providerKey === 'waha' ? 20 : 30
          )))),
          status: health.ok ? 'connected' : 'error',
          lastError: health.ok ? null : health.error ?? 'Health check failed',
          lastTestAt: testedAt,
        };
        if (!bundle.activeProvider || !bundle.providers[bundle.activeProvider]?.enabled) {
          bundle.activeProvider = body.providerKey;
        }
        await persistWhatsAppBundle(bundle);

        if (!health.ok) {
          return jsonRes(502, {
            error: `تعذّر الاتصال بـ ${PROVIDER_LABELS[body.providerKey]}: ${health.error ?? 'unknown error'}`,
            provider: publicProviderConfig(body.providerKey, bundle.providers[body.providerKey]),
          });
        }
        return jsonRes(200, {
          ok: true,
          activeProvider: chooseActiveProvider(bundle),
          provider: publicProviderConfig(body.providerKey, bundle.providers[body.providerKey]),
        });
      }

      case 'test_whatsapp_providers': {
        const { bundle } = await readWhatsAppBundle();
        for (const key of WHATSAPP_PROVIDER_KEYS) {
          const config = bundle.providers[key];
          if (!config?.baseUrl || !config.credential) continue;
          const health = await testWhatsAppProvider(key, config.baseUrl, config.credential);
          config.status = health.ok ? 'connected' : 'error';
          config.lastError = health.ok ? null : health.error ?? 'Health check failed';
          config.lastTestAt = new Date().toISOString();
        }
        await persistWhatsAppBundle(bundle);
        return jsonRes(200, {
          ok: true,
          activeProvider: chooseActiveProvider(bundle),
          providers: WHATSAPP_PROVIDER_KEYS.map((key) => publicProviderConfig(key, bundle.providers[key])),
        });
      }

      case 'set_whatsapp_provider_enabled': {
        if (!WHATSAPP_PROVIDER_KEYS.includes(body.providerKey)) return jsonRes(400, { error: 'Unknown WhatsApp provider' });
        const { bundle } = await readWhatsAppBundle();
        const config = bundle.providers[body.providerKey];
        if (!config) return jsonRes(404, { error: 'المزود غير مُعد' });
        config.enabled = body.enabled;
        await persistWhatsAppBundle(bundle);
        return jsonRes(200, { ok: true, activeProvider: chooseActiveProvider(bundle) });
      }

      case 'set_whatsapp_active_provider': {
        if (!WHATSAPP_PROVIDER_KEYS.includes(body.providerKey)) return jsonRes(400, { error: 'Unknown WhatsApp provider' });
        const { bundle } = await readWhatsAppBundle();
        const config = bundle.providers[body.providerKey];
        if (!config?.enabled || config.status !== 'connected') {
          return jsonRes(409, { error: 'المزود المطلوب ليس سليمًا ومفعّلًا' });
        }
        bundle.activeProvider = body.providerKey;
        await persistWhatsAppBundle(bundle);
        return jsonRes(200, { ok: true, activeProvider: body.providerKey });
      }

      case 'remove_whatsapp_provider': {
        if (!WHATSAPP_PROVIDER_KEYS.includes(body.providerKey)) return jsonRes(400, { error: 'Unknown WhatsApp provider' });
        const { bundle } = await readWhatsAppBundle();
        delete bundle.providers[body.providerKey];
        if (bundle.activeProvider === body.providerKey) bundle.activeProvider = null;
        await persistWhatsAppBundle(bundle);
        return jsonRes(200, { ok: true, activeProvider: chooseActiveProvider(bundle) });
      }

      case 'save_app': {
        if (!VALID_PLATFORM_KEYS.has(body.platformKey)) return jsonRes(400, { error: 'Unknown platform' });

        // Compatibility: old clients that still save WhatsApp as one provider
        // are transparently migrated into the Evolution slot.
        if (body.platformKey === 'whatsapp') {
          if (!body.appId?.trim()) return jsonRes(400, { error: 'Evolution Base URL is required' });
          const { bundle } = await readWhatsAppBundle();
          const previous = bundle.providers.evolution;
          const credential = body.appSecret?.trim() || previous?.credential || '';
          if (!credential) return jsonRes(400, { error: 'Evolution API Key مطلوب' });
          const baseUrl = normalizeBaseUrl(body.appId);
          const health = await testEvolution(baseUrl, credential);
          bundle.providers.evolution = {
            baseUrl,
            credential,
            enabled: true,
            priority: previous?.priority ?? 10,
            status: health.ok ? 'connected' : 'error',
            lastError: health.ok ? null : health.error ?? 'Health check failed',
            lastTestAt: new Date().toISOString(),
          };
          bundle.activeProvider = bundle.activeProvider ?? 'evolution';
          await persistWhatsAppBundle(bundle);
          if (!health.ok) return jsonRes(502, { error: `تعذّر الاتصال بـ Evolution: ${health.error ?? 'unknown error'}` });
          return jsonRes(200, { ok: true, redirectUri: null });
        }

        if (!body.appId || body.appId.trim().length < 3) return jsonRes(400, { error: 'App ID is required' });
        const functionsBase = `${Deno.env.get('SUPABASE_URL') ?? ''}/functions/v1`;
        const redirectUri = REDIRECT_URI_PLATFORMS.has(body.platformKey)
          ? body.redirectUri?.trim() || `${functionsBase}/social-oauth-callback`
          : null;

        if (body.appSecret && body.appSecret.trim().length > 0) {
          await supabase.from('social_platform_app_secrets').upsert({
            platform_key: body.platformKey,
            app_secret: body.appSecret.trim(),
            updated_at: new Date().toISOString(),
          });
        }

        if (body.platformKey === 'meta' && body.configurationId?.trim()) {
          await supabase.from('system_settings').upsert({
            key: 'social.meta.whatsapp_embedded_signup',
            value: { configuration_id: body.configurationId.trim() },
            updated_at: new Date().toISOString(),
          }, { onConflict: 'key' });
        }

        const { data: existingSecret } = await supabase
          .from('social_platform_app_secrets')
          .select('platform_key')
          .eq('platform_key', body.platformKey)
          .maybeSingle();

        await supabase.from('social_platform_apps').update({
          app_id: body.appId.trim(),
          redirect_uri: redirectUri,
          has_secret: !!existingSecret,
          status: existingSecret ? 'connected' : 'not_configured',
          enabled: !!existingSecret,
          last_error: null,
          updated_at: new Date().toISOString(),
        }).eq('platform_key', body.platformKey);

        return jsonRes(200, { ok: true, redirectUri });
      }

      case 'set_enabled': {
        if (body.platformKey === 'whatsapp') {
          const { bundle } = await readWhatsAppBundle();
          for (const config of Object.values(bundle.providers)) {
            if (config) config.enabled = body.enabled && config.status === 'connected';
          }
          await persistWhatsAppBundle(bundle);
          return jsonRes(200, { ok: true });
        }
        await supabase.from('social_platform_apps').update({ enabled: body.enabled }).eq('platform_key', body.platformKey);
        return jsonRes(200, { ok: true });
      }

      case 'remove_app': {
        if (body.platformKey === 'whatsapp') {
          await supabase.from('social_platform_app_secrets').delete().eq('platform_key', 'whatsapp');
          await supabase.from('social_platform_apps').update({
            app_id: null,
            has_secret: false,
            enabled: false,
            status: 'not_configured',
            last_error: null,
          }).eq('platform_key', 'whatsapp');
          return jsonRes(200, { ok: true });
        }

        await supabase.from('social_platform_app_secrets').delete().eq('platform_key', body.platformKey);
        if (body.platformKey === 'meta') {
          await supabase.from('system_settings').delete().eq('key', 'social.meta.whatsapp_embedded_signup');
        }
        await supabase.from('social_platform_apps').update({
          app_id: null,
          has_secret: false,
          enabled: false,
          status: 'not_configured',
          last_error: null,
        }).eq('platform_key', body.platformKey);
        return jsonRes(200, { ok: true });
      }

      default:
        return jsonRes(400, { error: 'Unknown action' });
    }
  } catch (err) {
    return jsonRes(500, { error: err instanceof Error ? err.message : 'Internal error' });
  }
});
