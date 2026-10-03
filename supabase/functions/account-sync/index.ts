import { handleWhatsAppProvider } from '../_shared/whatsapp-provider-handler.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const GRAPH_VERSION = Deno.env.get('META_GRAPH_VERSION') ?? 'v26.0';
const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

type AccountRow = {
  id: string;
  workspace_id: string;
  platform: string;
  external_id: string | null;
  page_id: string | null;
  ig_user_id: string | null;
  handle: string | null;
  display_name: string | null;
  status: string;
  needs_reconnect: boolean;
  metadata: Record<string, unknown> | null;
};

type SyncOutcome = {
  ok: boolean;
  status: 'connected' | 'error' | 'expired';
  handle?: string;
  display_name?: string;
  error?: string;
};

type TokenRow = {
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function tokenExpired(token: TokenRow | null): boolean {
  return Boolean(token?.expires_at && new Date(token.expires_at).getTime() <= Date.now() + 60_000);
}

async function readToken(accountId: string): Promise<TokenRow | null> {
  const { data } = await supabase
    .from('social_account_tokens')
    .select('access_token, refresh_token, expires_at')
    .eq('account_id', accountId)
    .maybeSingle();
  return (data as TokenRow | null) ?? null;
}

async function saveRefreshedToken(accountId: string, payload: { access_token: string; refresh_token?: string | null; expires_in?: number }): Promise<TokenRow> {
  const expiresAt = typeof payload.expires_in === 'number'
    ? new Date(Date.now() + payload.expires_in * 1000).toISOString()
    : null;
  const current = await readToken(accountId);
  const next: TokenRow = {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token ?? current?.refresh_token ?? null,
    expires_at: expiresAt,
  };
  await supabase.from('social_account_tokens').update({
    access_token: next.access_token,
    refresh_token: next.refresh_token,
    expires_at: next.expires_at,
    updated_at: new Date().toISOString(),
  }).eq('account_id', accountId);
  return next;
}

async function readPlatformCredentials(platformKey: string): Promise<{ appId: string; appSecret: string }> {
  const [{ data: app }, { data: secret }] = await Promise.all([
    supabase.from('social_platform_apps').select('app_id').eq('platform_key', platformKey).maybeSingle(),
    supabase.from('social_platform_app_secrets').select('app_secret').eq('platform_key', platformKey).maybeSingle(),
  ]);
  if (!app?.app_id || !secret?.app_secret) throw new Error(`إعدادات ${platformKey} غير مكتملة`);
  return { appId: String(app.app_id), appSecret: String(secret.app_secret) };
}

async function freshToken(account: AccountRow, token: TokenRow): Promise<TokenRow> {
  const expiresAt = token.expires_at ? new Date(token.expires_at).getTime() : null;
  const now = Date.now();

  if (account.platform === 'threads') {
    if (!expiresAt || expiresAt > now + 7 * 24 * 60 * 60 * 1000) return token;
    if (expiresAt <= now || !token.access_token) throw new Error('انتهت صلاحية Threads — أعد ربط الحساب');
    const url = new URL('https://graph.threads.net/refresh_access_token');
    url.searchParams.set('grant_type', 'th_refresh_token');
    url.searchParams.set('access_token', token.access_token);
    const response = await fetch(url);
    const body = await readJson(response);
    if (!response.ok || typeof body.access_token !== 'string') throw new Error('فشل تجديد Threads — أعد ربط الحساب');
    return saveRefreshedToken(account.id, {
      access_token: String(body.access_token),
      expires_in: typeof body.expires_in === 'number' ? body.expires_in : undefined,
    });
  }

  if (account.platform === 'x' && expiresAt && expiresAt <= now + 10 * 60 * 1000) {
    if (!token.refresh_token) throw new Error('انتهت صلاحية إكس — أعد ربط الحساب');
    const credentials = await readPlatformCredentials('x');
    const response = await fetch('https://api.twitter.com/2/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${btoa(`${credentials.appId}:${credentials.appSecret}`)}`,
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: token.refresh_token,
        client_id: credentials.appId,
      }),
    });
    const body = await readJson(response);
    if (!response.ok || typeof body.access_token !== 'string') throw new Error(typeof body.error_description === 'string' ? body.error_description : 'فشل تجديد إكس');
    return saveRefreshedToken(account.id, {
      access_token: String(body.access_token),
      refresh_token: typeof body.refresh_token === 'string' ? body.refresh_token : token.refresh_token,
      expires_in: typeof body.expires_in === 'number' ? body.expires_in : undefined,
    });
  }

  if (account.platform === 'tiktok' && expiresAt && expiresAt <= now + 30 * 60 * 1000) {
    if (!token.refresh_token) throw new Error('انتهت صلاحية TikTok — أعد ربط الحساب');
    const credentials = await readPlatformCredentials('tiktok');
    const response = await fetch('https://open.tiktokapis.com/v2/oauth/token/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
      body: new URLSearchParams({
        client_key: credentials.appId,
        client_secret: credentials.appSecret,
        grant_type: 'refresh_token',
        refresh_token: token.refresh_token,
      }),
    });
    const body = await readJson(response);
    if (!response.ok || typeof body.access_token !== 'string') {
      throw new Error(typeof body.error_description === 'string' ? body.error_description : 'فشل تجديد TikTok');
    }
    return saveRefreshedToken(account.id, {
      access_token: String(body.access_token),
      refresh_token: typeof body.refresh_token === 'string' ? body.refresh_token : token.refresh_token,
      expires_in: typeof body.expires_in === 'number' ? body.expires_in : undefined,
    });
  }

  return token;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json().catch(() => ({})) as Record<string, unknown>;
}

async function checkMeta(account: AccountRow, accessToken: string): Promise<SyncOutcome> {
  const providerId = account.platform === 'instagram'
    ? account.ig_user_id ?? account.external_id
    : account.page_id ?? account.external_id;
  if (!providerId) return { ok: false, status: 'error', error: 'معرّف الحساب الخارجي غير موجود' };

  const fields = account.platform === 'instagram' ? 'id,username,name' : 'id,name,username';
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${providerId}`);
  url.searchParams.set('fields', fields);
  url.searchParams.set('access_token', accessToken);
  const response = await fetch(url);
  const body = await readJson(response);
  if (!response.ok) {
    const message = typeof (body.error as Record<string, unknown> | undefined)?.message === 'string'
      ? String((body.error as Record<string, unknown>).message)
      : `${response.status} ${response.statusText}`;
    const expired = Number((body.error as Record<string, unknown> | undefined)?.code) === 190 || response.status === 401;
    return { ok: false, status: expired ? 'expired' : 'error', error: message };
  }

  return {
    ok: true,
    status: 'connected',
    handle: typeof body.username === 'string' ? `@${body.username}` : undefined,
    display_name: typeof body.name === 'string' ? body.name : undefined,
  };
}

async function checkX(accessToken: string): Promise<SyncOutcome> {
  const response = await fetch('https://api.twitter.com/2/users/me?user.fields=name,username', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await readJson(response);
  if (!response.ok) {
    const message = typeof body.detail === 'string' ? body.detail : `${response.status} ${response.statusText}`;
    return { ok: false, status: response.status === 401 ? 'expired' : 'error', error: message };
  }
  const data = (body.data ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    status: 'connected',
    handle: typeof data.username === 'string' ? `@${data.username}` : undefined,
    display_name: typeof data.name === 'string' ? data.name : undefined,
  };
}

async function checkLinkedIn(accessToken: string): Promise<SyncOutcome> {
  const response = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await readJson(response);
  if (!response.ok) {
    const message = typeof body.message === 'string' ? body.message : `${response.status} ${response.statusText}`;
    return { ok: false, status: response.status === 401 ? 'expired' : 'error', error: message };
  }
  const name = [body.given_name, body.family_name].filter((value) => typeof value === 'string' && value).join(' ');
  return {
    ok: true,
    status: 'connected',
    handle: typeof body.email === 'string' ? body.email : undefined,
    display_name: name || undefined,
  };
}

async function checkThreads(account: AccountRow, accessToken: string): Promise<SyncOutcome> {
  const providerId = account.ig_user_id ?? account.external_id;
  if (!providerId) return { ok: false, status: 'error', error: 'معرّف Threads غير موجود' };
  const url = new URL(`https://graph.threads.net/v1.0/${providerId}`);
  url.searchParams.set('fields', 'id,username,name');
  url.searchParams.set('access_token', accessToken);
  const response = await fetch(url);
  const body = await readJson(response);
  if (!response.ok) {
    const message = typeof (body.error as Record<string, unknown> | undefined)?.message === 'string'
      ? String((body.error as Record<string, unknown>).message)
      : `${response.status} ${response.statusText}`;
    return { ok: false, status: response.status === 401 ? 'expired' : 'error', error: message };
  }
  return {
    ok: true,
    status: 'connected',
    handle: typeof body.username === 'string' ? `@${body.username}` : undefined,
    display_name: typeof body.name === 'string' ? body.name : undefined,
  };
}

async function checkTikTok(accessToken: string): Promise<SyncOutcome> {
  const response = await fetch('https://open.tiktokapis.com/v2/user/info/?fields=display_name,username', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = await readJson(response);
  const apiError = (body.error ?? {}) as Record<string, unknown>;
  if (!response.ok || (apiError.code && apiError.code !== 'ok')) {
    const message = typeof apiError.message === 'string' ? apiError.message : `${response.status} ${response.statusText}`;
    return { ok: false, status: response.status === 401 ? 'expired' : 'error', error: message };
  }
  const user = (body.data as Record<string, unknown> | undefined)?.user as Record<string, unknown> | undefined;
  return {
    ok: true,
    status: 'connected',
    handle: typeof user?.username === 'string' ? `@${user.username}` : undefined,
    display_name: typeof user?.display_name === 'string' ? user.display_name : undefined,
  };
}

async function checkTelegram(accessToken: string): Promise<SyncOutcome> {
  const response = await fetch(`https://api.telegram.org/bot${accessToken}/getMe`);
  const body = await readJson(response);
  if (!response.ok || body.ok !== true) {
    return { ok: false, status: response.status === 401 ? 'expired' : 'error', error: typeof body.description === 'string' ? body.description : 'Telegram bot token غير صالح' };
  }
  const user = (body.result ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    status: 'connected',
    handle: typeof user.username === 'string' ? `@${user.username}` : undefined,
    display_name: typeof user.first_name === 'string' ? user.first_name : undefined,
  };
}

async function checkWhatsApp(account: AccountRow, accessToken: string): Promise<SyncOutcome> {
  const providerId = account.external_id ?? account.page_id;
  if (!providerId) return { ok: false, status: 'error', error: 'معرّف WhatsApp غير موجود' };
  const url = new URL(`https://graph.facebook.com/${GRAPH_VERSION}/${providerId}`);
  url.searchParams.set('fields', 'verified_name,display_phone_number,quality_rating');
  url.searchParams.set('access_token', accessToken);
  const response = await fetch(url);
  const body = await readJson(response);
  if (!response.ok) {
    const message = typeof (body.error as Record<string, unknown> | undefined)?.message === 'string'
      ? String((body.error as Record<string, unknown>).message)
      : `${response.status} ${response.statusText}`;
    return { ok: false, status: response.status === 401 ? 'expired' : 'error', error: message };
  }
  return {
    ok: true,
    status: 'connected',
    display_name: typeof body.verified_name === 'string' ? body.verified_name : (typeof body.display_phone_number === 'string' ? body.display_phone_number : undefined),
  };
}

async function checkAccount(account: AccountRow): Promise<SyncOutcome> {
  if (account.platform === 'whatsapp') {
    const provider = account.metadata?.provider;
    if (provider === 'evolution' || provider === 'waha' || provider === 'wppconnect') {
      throw new Error('WhatsApp Web checks must use the serialized lifecycle');
    }
  }

  const storedToken = await readToken(account.id);
  if (!storedToken?.access_token) return { ok: false, status: 'error', error: 'رمز الوصول غير موجود' };

  let token: TokenRow;
  try {
    token = await freshToken(account, storedToken);
  } catch (error) {
    return { ok: false, status: 'expired', error: error instanceof Error ? error.message : 'تعذّر تجديد رمز الوصول' };
  }
  if (!token.access_token || tokenExpired(token)) {
    return { ok: false, status: 'expired', error: 'انتهت صلاحية رمز الوصول؛ أعد ربط الحساب' };
  }

  switch (account.platform) {
    case 'facebook':
    case 'instagram':
      return checkMeta(account, token.access_token);
    case 'x':
      return checkX(token.access_token);
    case 'linkedin':
      return checkLinkedIn(token.access_token);
    case 'threads':
      return checkThreads(account, token.access_token);
    case 'tiktok':
      return checkTikTok(token.access_token);
    case 'telegram':
      return checkTelegram(token.access_token);
    case 'whatsapp':
      return checkWhatsApp(account, token.access_token);
    default:
      return { ok: false, status: 'error', error: `المنصة غير مدعومة: ${account.platform}` };
  }
}

async function syncOne(account: AccountRow): Promise<SyncOutcome> {
  if (account.platform === 'whatsapp' && ['evolution', 'waha', 'wppconnect'].includes(String(account.metadata?.provider))) {
    const response = await handleWhatsAppProvider(new Request('https://internal.test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'status', workspaceId: account.workspace_id }),
    }), undefined, account.workspace_id);
    const result = await response.json();
    return { ok: response.ok && result.connected === true, status: result.connected ? 'connected' : 'error',
      ...(response.ok && result.connected ? {} : { error: result.error ?? result.lastError ?? `WhatsApp state: ${result.state}` }),
      account_id: account.id, platform: account.platform,
    } as SyncOutcome;
  }
  const startedAt = new Date().toISOString();
  await supabase.from('social_accounts').update({ last_sync_at: startedAt }).eq('id', account.id);

  let outcome: SyncOutcome;
  try {
    outcome = await checkAccount(account);
  } catch (error) {
    outcome = { ok: false, status: 'error', error: error instanceof Error ? error.message : 'فشل فحص الحساب' };
  }

  const metadata = { ...(account.metadata ?? {}) };
  if (outcome.ok) {
    delete metadata.last_sync_error;
    delete metadata.last_sync_error_at;
  } else {
    metadata.last_sync_error = outcome.error ?? 'فشل فحص الحساب';
    metadata.last_sync_error_at = new Date().toISOString();
  }

  await supabase.from('social_accounts').update({
    status: outcome.status,
    needs_reconnect: outcome.status === 'expired' || (
      account.platform === 'whatsapp'
      && ['evolution', 'waha', 'wppconnect'].includes(String(account.metadata?.provider ?? ''))
      && !outcome.ok
    ),
    ...(outcome.handle ? { handle: outcome.handle } : {}),
    ...(outcome.display_name ? { display_name: outcome.display_name } : {}),
    metadata,
    last_sync_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('id', account.id);

  return { ...outcome, account_id: account.id, platform: account.platform } as SyncOutcome & { account_id: string; platform: string };
}

async function callerId(req: Request): Promise<string | null> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  return error || !data.user ? null : data.user.id;
}

async function hasWorkspaceAccess(workspaceId: string, userId: string): Promise<boolean> {
  const { data } = await supabase
    .from('workspace_members')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();
  return Boolean(data);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const userId = await callerId(req);
  if (!userId) return json(401, { error: 'Unauthorized' });

  const body = await req.json().catch(() => ({})) as { account_id?: string; workspace_id?: string };
  if (!body.account_id && !body.workspace_id) return json(400, { error: 'account_id or workspace_id is required' });

  let accounts: AccountRow[] = [];
  if (body.account_id) {
    const { data: account, error } = await supabase
      .from('social_accounts')
      .select('id,workspace_id,platform,external_id,page_id,ig_user_id,handle,display_name,status,needs_reconnect,metadata')
      .eq('id', body.account_id)
      .maybeSingle();
    if (error) return json(500, { error: error.message });
    if (!account) return json(404, { error: 'Account not found' });
    if (!await hasWorkspaceAccess(account.workspace_id, userId)) return json(403, { error: 'Workspace access denied' });
    accounts = [account as AccountRow];
  } else {
    if (!await hasWorkspaceAccess(body.workspace_id!, userId)) return json(403, { error: 'Workspace access denied' });
    const { data, error } = await supabase
      .from('social_accounts')
      .select('id,workspace_id,platform,external_id,page_id,ig_user_id,handle,display_name,status,needs_reconnect,metadata')
      .eq('workspace_id', body.workspace_id!)
      .in('status', ['connected', 'expired', 'error']);
    if (error) return json(500, { error: error.message });
    accounts = (data ?? []) as AccountRow[];
  }

  const results = [];
  for (const account of accounts) results.push(await syncOne(account));
  return json(200, { synced: results.length, results });
});
