import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

// ---------------------------------------------------------------------------
// Social Integrations Control Center backend — Super Admin only. Mirrors the
// ai-admin function's split pattern: non-secret config lives in
// social_platform_apps (readable by supabase clients once is_super_admin()),
// the app secret lives in social_platform_app_secrets which has no RLS
// policies at all and is reachable only from here via the service role.
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

  // The service-role client has no auth.uid(), while the database helper
  // intentionally requires check_uid = auth.uid(). Validate the already
  // verified user directly against the protected platform_admins table.
  const { data: adminRow, error: adminError } = await supabase.from('platform_admins').select('user_id').eq('user_id', userData.user.id).maybeSingle();
  if (adminError) return { ok: false, response: jsonRes(500, { error: 'Unable to verify Super Admin permissions' }) };
  if (!adminRow) return { ok: false, response: jsonRes(403, { error: 'Forbidden — Super Admin only' }) };

  return { ok: true, userId: userData.user.id };
}

const VALID_PLATFORM_KEYS = new Set(['meta', 'linkedin', 'telegram', 'x', 'threads', 'tiktok', 'whatsapp']);

// Telegram doesn't use redirect-based OAuth (no app is "installed" on a
// domain) — app_id holds the shared bot's @username and app_secret holds
// its Bot Token, so there's no redirect_uri to generate or display.
// Meta, LinkedIn, and X are all standard redirect-based OAuth apps.
const REDIRECT_URI_PLATFORMS = new Set(['meta', 'linkedin', 'x', 'threads', 'tiktok']);

async function testEvolution(baseUrl: string, apiKey: string): Promise<{ ok: boolean; error?: string }> {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  try {
    const response = await fetch(`${normalized}/instance/fetchInstances`, {
      headers: { apikey: apiKey },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      const nested = body.response as Record<string, unknown> | undefined;
      const message = nested?.message ?? body.message ?? body.error;
      return {
        ok: false,
        error: typeof message === 'string'
          ? message
          : `Evolution HTTP ${response.status}`,
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'تعذّر الوصول إلى Evolution API',
    };
  }
}

type Action =
  | { action: 'list_apps' }
  | { action: 'save_app'; platformKey: string; appId: string; appSecret?: string; redirectUri?: string; configurationId?: string }
  | { action: 'set_enabled'; platformKey: string; enabled: boolean }
  | { action: 'remove_app'; platformKey: string };

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
        const [{ data, error }, { data: embeddedSetting }] = await Promise.all([
          supabase.from('social_platform_apps').select('*').order('platform_key'),
          supabase.from('system_settings').select('value').eq('key', 'social.meta.whatsapp_embedded_signup').maybeSingle(),
        ]);
        if (error) return jsonRes(500, { error: error.message });
        const embedded = (embeddedSetting?.value ?? {}) as Record<string, unknown>;
        const apps = (data ?? []).map((app) => app.platform_key === 'meta'
          ? { ...app, configuration_id: typeof embedded.configuration_id === 'string' ? embedded.configuration_id : null }
          : app);
        return jsonRes(200, { apps });
      }

      case 'save_app': {
        if (!VALID_PLATFORM_KEYS.has(body.platformKey)) return jsonRes(400, { error: 'Unknown platform' });
        if (!body.appId || body.appId.trim().length < 3) return jsonRes(400, { error: body.platformKey === 'whatsapp' ? 'Evolution Base URL is required' : 'App ID is required' });

        if (body.platformKey === 'whatsapp') {
          try {
            const url = new URL(body.appId.trim());
            if (!['http:', 'https:'].includes(url.protocol)) throw new Error('bad protocol');
          } catch {
            return jsonRes(400, { error: 'Evolution Base URL غير صالح' });
          }
        }

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
          .select('platform_key,app_secret')
          .eq('platform_key', body.platformKey)
          .maybeSingle();

        if (body.platformKey === 'whatsapp') {
          if (!existingSecret?.app_secret) {
            await supabase.from('social_platform_apps').update({
              app_id: body.appId.trim(),
              redirect_uri: null,
              has_secret: false,
              status: 'not_configured',
              enabled: false,
              last_error: 'Evolution API Key مطلوب',
              updated_at: new Date().toISOString(),
            }).eq('platform_key', body.platformKey);
            return jsonRes(400, { error: 'Evolution API Key مطلوب' });
          }

          const health = await testEvolution(body.appId.trim(), String(existingSecret.app_secret));
          await supabase.from('social_platform_apps').update({
            app_id: body.appId.trim().replace(/\/+$/, ''),
            redirect_uri: null,
            has_secret: true,
            status: health.ok ? 'connected' : 'error',
            enabled: health.ok,
            last_test_at: new Date().toISOString(),
            last_error: health.ok ? null : health.error ?? 'Evolution health check failed',
            updated_at: new Date().toISOString(),
          }).eq('platform_key', body.platformKey);

          if (!health.ok) {
            return jsonRes(502, { error: `تعذّر الاتصال بـ Evolution: ${health.error ?? 'unknown error'}` });
          }
          return jsonRes(200, { ok: true, redirectUri: null });
        }

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
        await supabase.from('social_platform_apps').update({ enabled: body.enabled }).eq('platform_key', body.platformKey);
        return jsonRes(200, { ok: true });
      }

      case 'remove_app': {
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
    const message = err instanceof Error ? err.message : 'Internal error';
    return jsonRes(500, { error: message });
  }
});
