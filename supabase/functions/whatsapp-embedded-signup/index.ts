import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};
const VERSION = Deno.env.get('META_GRAPH_VERSION') ?? 'v26.0';
const GRAPH = `https://graph.facebook.com/${VERSION}`;
const db = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

function out(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function credentials() {
  const [{ data: app }, { data: secret }, { data: setting }] = await Promise.all([
    db.from('social_platform_apps').select('app_id').eq('platform_key', 'meta').maybeSingle(),
    db.from('social_platform_app_secrets').select('app_secret').eq('platform_key', 'meta').maybeSingle(),
    db.from('system_settings').select('value').eq('key', 'social.meta.whatsapp_embedded_signup').maybeSingle(),
  ]);
  const value = (setting?.value ?? {}) as Record<string, unknown>;
  const appId = String(app?.app_id ?? Deno.env.get('META_APP_ID') ?? '').trim();
  const appSecret = String(secret?.app_secret ?? Deno.env.get('META_APP_SECRET') ?? '').trim();
  const configId = String(value.configuration_id ?? Deno.env.get('META_CONFIG_ID') ?? '').trim();
  if (!appId || !appSecret) throw new Error('Meta App غير مُعد على SocialPilot');
  return { appId, appSecret, configId };
}

async function authorize(req: Request, workspaceId: string) {
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: auth } = await db.auth.getUser(jwt);
  if (!auth.user) return null;
  const { data: member } = await db.from('workspace_members')
    .select('role').eq('workspace_id', workspaceId).eq('user_id', auth.user.id).maybeSingle();
  if (!member || !['owner', 'admin'].includes(String(member.role))) return null;
  return auth.user.id;
}

async function graph(url: string, token: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    const apiError = body.error as Record<string, unknown> | undefined;
    throw new Error(typeof apiError?.message === 'string' ? apiError.message : `Meta API ${response.status}`);
  }
  return body;
}

async function exchangeCode(code: string, appId: string, appSecret: string) {
  const url = new URL(`${GRAPH}/oauth/access_token`);
  url.searchParams.set('client_id', appId);
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('code', code);
  const response = await fetch(url);
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || typeof body.access_token !== 'string') {
    const err = body.error as Record<string, unknown> | undefined;
    throw new Error(typeof err?.message === 'string' ? err.message : 'تعذّر إكمال تفويض Meta');
  }
  return body.access_token;
}

async function tokenInfo(token: string, appId: string, appSecret: string) {
  const url = new URL(`${GRAPH}/debug_token`);
  url.searchParams.set('input_token', token);
  url.searchParams.set('access_token', `${appId}|${appSecret}`);
  const body = await (await fetch(url)).json().catch(() => ({})) as Record<string, unknown>;
  const data = body.data as Record<string, unknown> | undefined;
  if (data?.is_valid !== true) throw new Error('تفويض WhatsApp غير صالح');

  const scopes = Array.isArray(data.scopes) ? data.scopes.filter((x): x is string => typeof x === 'string') : [];
  const granular = Array.isArray(data.granular_scopes) ? data.granular_scopes as Array<Record<string, unknown>> : [];
  const allScopes = Array.from(new Set([
    ...scopes,
    ...granular.map((x) => x.scope).filter((x): x is string => typeof x === 'string'),
  ]));
  for (const needed of ['whatsapp_business_management', 'whatsapp_business_messaging']) {
    if (!allScopes.includes(needed)) throw new Error(`Meta لم تمنح صلاحية ${needed}`);
  }
  const wabIds = Array.from(new Set(granular.flatMap((x) =>
    Array.isArray(x.target_ids) ? x.target_ids.filter((id): id is string => typeof id === 'string') : []
  )));
  const expires = typeof data.expires_at === 'number' && data.expires_at > 0
    ? new Date(data.expires_at * 1000).toISOString()
    : null;
  return { scopes: allScopes, wabIds, expires };
}

async function configureWebhook(appId: string, appSecret: string) {
  const verify = Deno.env.get('META_WEBHOOK_VERIFY_TOKEN');
  const base = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
  if (!verify || !base) throw new Error('Webhook WhatsApp غير مُعد على الخادم');
  const callback = `${base}/functions/v1/inbox-webhook`;
  const form = new URLSearchParams({
    object: 'whatsapp_business_account',
    callback_url: callback,
    fields: 'messages',
    verify_token: verify,
    access_token: `${appId}|${appSecret}`,
  });
  const response = await fetch(`${GRAPH}/${appId}/subscriptions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok || body.success !== true) throw new Error('تعذّر تفعيل WhatsApp Webhook تلقائيًا');
  return callback;
}

async function saveConnection(params: {
  workspaceId: string; userId: string; wabaId: string; phone: Record<string, unknown>;
  token: string; expires: string | null; scopes: string[]; webhook: string;
}) {
  const phoneId = String(params.phone.id ?? '');
  const display = String(params.phone.display_phone_number ?? phoneId);
  const name = String(params.phone.verified_name ?? display);
  const { data: account, error } = await db.from('social_accounts').upsert({
    workspace_id: params.workspaceId,
    platform: 'whatsapp',
    external_id: phoneId,
    handle: display,
    display_name: name,
    status: 'error',
    needs_reconnect: false,
    metadata: {
      waba_id: params.wabaId,
      phone_number_id: phoneId,
      display_phone_number: display,
      verified_name: name,
      quality_rating: params.phone.quality_rating ?? null,
      webhook_subscribed: true,
      webhook_url: params.webhook,
      connected_via: 'meta_embedded_signup',
      onboarding_state: 'needs_registration',
      token_scopes: params.scopes,
    },
    last_sync_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'workspace_id,platform' }).select().single();
  if (error || !account) throw new Error(error?.message ?? 'تعذّر حفظ WhatsApp');

  const { error: tokenError } = await db.from('social_account_tokens').upsert({
    account_id: account.id,
    access_token: params.token,
    refresh_token: null,
    token_type: 'whatsapp_bisu',
    expires_at: params.expires,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'account_id' });
  if (tokenError) throw tokenError;

  await db.from('audit_logs').insert({
    workspace_id: params.workspaceId,
    user_id: params.userId,
    action: 'whatsapp_embedded_signup',
    entity: 'social_account',
    entity_id: account.id,
    detail: { waba_id: params.wabaId, phone_number_id: phoneId, onboarding_state: 'needs_registration' },
  });
  return account;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return out(405, { error: 'Method not allowed' });

  const body = await req.json().catch(() => ({})) as {
    action?: 'get_config' | 'complete' | 'register';
    workspaceId?: string; code?: string; wabaId?: string; phoneNumberId?: string; pin?: string;
  };
  const workspaceId = body.workspaceId?.trim();
  if (!workspaceId) return out(400, { error: 'workspaceId مطلوب' });
  const userId = await authorize(req, workspaceId);
  if (!userId) return out(403, { error: 'غير مسموح بربط WhatsApp لهذه المساحة' });

  try {
    const { appId, appSecret, configId } = await credentials();

    if (body.action === 'get_config') {
      if (!configId) return out(409, { configured: false, error: 'Embedded Signup Configuration ID غير مُعد' });
      return out(200, { configured: true, appId, configurationId: configId, graphVersion: VERSION });
    }

    if (body.action === 'register') {
      const pin = body.pin?.trim() ?? '';
      if (!/^\d{6}$/.test(pin)) return out(400, { error: 'PIN يجب أن يكون 6 أرقام' });
      const { data: account } = await db.from('social_accounts').select('id,external_id,metadata')
        .eq('workspace_id', workspaceId).eq('platform', 'whatsapp').maybeSingle();
      if (!account?.id || !account.external_id) return out(404, { error: 'لا يوجد رقم WhatsApp قيد التسجيل' });
      const { data: tokenRow } = await db.from('social_account_tokens').select('access_token')
        .eq('account_id', account.id).maybeSingle();
      if (!tokenRow?.access_token) return out(409, { error: 'توكن WhatsApp غير موجود' });

      const registered = await graph(`${GRAPH}/${account.external_id}/register`, tokenRow.access_token, {
        method: 'POST',
        body: JSON.stringify({ messaging_product: 'whatsapp', pin }),
      });
      if (registered.success !== true) throw new Error('Meta لم تؤكد تسجيل الرقم');
      await db.from('social_accounts').update({
        status: 'connected',
        metadata: { ...(account.metadata ?? {}), onboarding_state: 'ready', phone_status: 'CONNECTED' },
        last_sync_at: new Date().toISOString(),
      }).eq('id', account.id);
      return out(200, { ok: true });
    }

    if (body.action !== 'complete' || !body.code?.trim()) return out(400, { error: 'طلب Embedded Signup غير مكتمل' });
    const token = await exchangeCode(body.code.trim(), appId, appSecret);
    const info = await tokenInfo(token, appId, appSecret);
    const wabaId = body.wabaId?.trim() || (info.wabIds.length === 1 ? info.wabIds[0] : '');
    if (!wabaId) throw new Error('Meta لم تُرجع WhatsApp Business Account بشكل واضح');

    const webhook = await configureWebhook(appId, appSecret);
    await graph(`${GRAPH}/${wabaId}/subscribed_apps`, token, { method: 'POST', body: '{}' });

    const phoneBody = await graph(
      `${GRAPH}/${wabaId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating`,
      token,
    );
    const phones = Array.isArray(phoneBody.data) ? phoneBody.data as Array<Record<string, unknown>> : [];
    const requestedPhoneId = body.phoneNumberId?.trim();
    const phone = requestedPhoneId
      ? phones.find((x) => String(x.id ?? '') === requestedPhoneId)
      : phones.length === 1 ? phones[0] : undefined;
    if (!phone) throw new Error('Meta لم تُرجع رقم WhatsApp المختار؛ أعد نافذة الربط وأكمل اختيار الرقم');

    const account = await saveConnection({
      workspaceId, userId, wabaId, phone, token, expires: info.expires, scopes: info.scopes, webhook,
    });
    return out(200, {
      ok: true,
      needsRegistration: true,
      account: { id: account.id, display_name: account.display_name, handle: account.handle, status: account.status },
    });
  } catch (error) {
    return out(502, { error: error instanceof Error ? error.message : 'فشل ربط WhatsApp' });
  }
});
