import { closeSession, disconnectedAccount } from '../_shared/whatsapp-session.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { autoRefreshToken: false, persistSession: false } },
);

type Action = 'start' | 'status' | 'disconnect';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  const parsed = new URL(trimmed);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Evolution Base URL غير صالح');
  return parsed.toString().replace(/\/$/, '');
}

function instanceName(workspaceId: string): string {
  return `socialpilot_${workspaceId.replace(/-/g, '')}`;
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function config(): Promise<{ baseUrl: string; apiKey: string }> {
  const [{ data: app }, { data: secret }] = await Promise.all([
    supabase.from('social_platform_apps')
      .select('app_id,enabled,status')
      .eq('platform_key', 'whatsapp')
      .maybeSingle(),
    supabase.from('social_platform_app_secrets')
      .select('app_secret')
      .eq('platform_key', 'whatsapp')
      .maybeSingle(),
  ]);

  if (!app?.enabled || !app.app_id || !secret?.app_secret) {
    throw new Error('مزود WhatsApp غير مُعد. أضف Evolution Base URL وAPI Key من Super Admin.');
  }
  return {
    baseUrl: normalizeBaseUrl(String(app.app_id)),
    apiKey: String(secret.app_secret),
  };
}

async function requireAdmin(req: Request, workspaceId: string): Promise<{ userId: string } | { response: Response }> {
  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!jwt) return { response: json(401, { error: 'Unauthorized' }) };

  const { data: auth } = await supabase.auth.getUser(jwt);
  if (!auth.user) return { response: json(401, { error: 'Unauthorized' }) };

  const { data: member } = await supabase.from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', auth.user.id)
    .maybeSingle();

  if (!member || !['owner', 'admin'].includes(String(member.role))) {
    return { response: json(403, { error: 'ربط WhatsApp متاح لمالك أو Admin مساحة العمل فقط' }) };
  }
  return { userId: auth.user.id };
}

async function evoFetch(
  cfg: { baseUrl: string; apiKey: string },
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(`${cfg.baseUrl}${path}`, {
    ...init,
    headers: {
      apikey: cfg.apiKey,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  return { response, body };
}

function evoError(body: Record<string, unknown>, fallback: string): string {
  const response = body.response as Record<string, unknown> | undefined;
  const message = response?.message ?? body.message ?? body.error;
  if (Array.isArray(message)) return message.map(String).join(' — ');
  if (typeof message === 'string') return message;
  return fallback;
}

async function setWebhook(
  cfg: { baseUrl: string; apiKey: string },
  instance: string,
  secret: string,
): Promise<void> {
  const supabaseUrl = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
  if (!supabaseUrl) throw new Error('SUPABASE_URL غير موجود');
  const url = `${supabaseUrl}/functions/v1/whatsapp-evolution-webhook`;
  const payload = {
    webhook: {
      enabled: true,
      url,
      webhookByEvents: false,
      webhookBase64: false,
      events: [
        'QRCODE_UPDATED',
        'CONNECTION_UPDATE',
        'MESSAGES_UPSERT',
        'MESSAGES_UPDATE',
        'SEND_MESSAGE',
        'SEND_MESSAGE_UPDATE',
      ],
      headers: {
        'x-socialpilot-secret': secret,
      },
    },
  };

  let result = await evoFetch(cfg, `/webhook/set/${encodeURIComponent(instance)}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (result.response.status === 404) {
    result = await evoFetch(cfg, `/event/webhook/set/${encodeURIComponent(instance)}`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }
  if (!result.response.ok) {
    throw new Error(evoError(result.body, 'Evolution رفض إعداد Webhook'));
  }
}

async function connectionState(
  cfg: { baseUrl: string; apiKey: string },
  instance: string,
): Promise<{ state: string; raw: Record<string, unknown> }> {
  const primary = await evoFetch(cfg, `/instance/connectionState/${encodeURIComponent(instance)}`);
  if (primary.response.ok) {
    const nested = primary.body.instance as Record<string, unknown> | undefined;
    const state = String(nested?.state ?? primary.body.state ?? 'unknown').toLowerCase();
    return { state, raw: primary.body };
  }

  const fallback = await evoFetch(
    cfg,
    `/instance/fetchInstances?instanceName=${encodeURIComponent(instance)}`,
  );
  if (!fallback.response.ok) return { state: 'missing', raw: fallback.body };
  const rows = Array.isArray(fallback.body) ? fallback.body : ((fallback.body.instances as unknown[]) ?? []);
  const row = Array.isArray(rows) ? rows[0] as Record<string, unknown> | undefined : undefined;
  const connection = row?.connectionStatus ?? row?.connectionState ?? row?.state;
  return { state: String(connection ?? 'unknown').toLowerCase(), raw: fallback.body };
}

function qrFrom(body: Record<string, unknown>): { base64: string | null; code: string | null; pairingCode: string | null } {
  const nested = body.qrcode as Record<string, unknown> | undefined;
  const base64 = [nested?.base64, body.base64]
    .find((value) => typeof value === 'string' && value.length > 20) as string | undefined;
  const code = [nested?.code, body.code]
    .find((value) => typeof value === 'string' && value.length > 3) as string | undefined;
  const pairingCode = [nested?.pairingCode, body.pairingCode]
    .find((value) => typeof value === 'string' && value.length > 2) as string | undefined;
  return { base64: base64 ?? null, code: code ?? null, pairingCode: pairingCode ?? null };
}

async function loadAccount(workspaceId: string) {
  const { data } = await supabase.from('social_accounts')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('platform', 'whatsapp')
    .maybeSingle();
  return data;
}

async function webhookSecretFor(accountId: string): Promise<string | null> {
  const { data } = await supabase.from('social_account_tokens')
    .select('refresh_token')
    .eq('account_id', accountId)
    .maybeSingle();
  return typeof data?.refresh_token === 'string' ? data.refresh_token : null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const body = await req.json().catch(() => ({})) as { action?: Action; workspaceId?: string };
  const workspaceId = body.workspaceId?.trim();
  if (!workspaceId || !body.action) return json(400, { error: 'workspaceId و action مطلوبين' });

  const auth = await requireAdmin(req, workspaceId);
  if ('response' in auth) return auth.response;

  try {
    const cfg = await config();
    const name = instanceName(workspaceId);
    let account = await loadAccount(workspaceId);

    if (body.action === 'status') {
      if (!account || account.metadata?.provider !== 'evolution') {
        return json(200, { configured: true, connected: false, state: 'not_created' });
      }
      const state = await connectionState(cfg, String(account.metadata.instance_name ?? name));
      const connected = ['open', 'connected'].includes(state.state);
      if (connected !== (account.status === 'connected')) {
        const { data: updated } = await supabase.from('social_accounts').update({
          status: connected ? 'connected' : 'error',
          needs_reconnect: !connected,
          last_sync_at: new Date().toISOString(),
          metadata: {
            ...(account.metadata ?? {}),
            provider_state: state.state,
          },
        }).eq('id', account.id).select().single();
        if (updated) account = updated;
      }
      return json(200, {
        configured: true,
        connected,
        state: state.state,
        account,
      });
    }

    if (body.action === 'disconnect') {
      const currentName = String(account?.metadata?.instance_name ?? name);
      await closeSession(`${cfg.baseUrl}/instance/delete/${encodeURIComponent(currentName)}`, { method: 'DELETE', headers: { apikey: cfg.apiKey } });
      if (account?.id) {
        const { error } = await supabase.from('social_accounts')
          .update(disconnectedAccount((account.metadata ?? {}) as Record<string, unknown>))
          .eq('id', account.id).eq('workspace_id', workspaceId);
        if (error) throw new Error('تعذّر حفظ حالة الفصل');
      }
      return json(200, { ok: true, connected: false, state: 'disconnected', accountId: account?.id ?? null });
    }

    let secret = account?.id ? await webhookSecretFor(account.id) : null;
    if (!secret) secret = randomSecret();

    const currentState = await connectionState(cfg, name);
    if (currentState.state === 'missing' || currentState.state === 'unknown') {
      const created = await evoFetch(cfg, '/instance/create', {
        method: 'POST',
        body: JSON.stringify({
          instanceName: name,
          integration: 'WHATSAPP-BAILEYS',
          qrcode: true,
          rejectCall: true,
          groupsIgnore: true,
          alwaysOnline: false,
          readMessages: false,
          readStatus: false,
          syncFullHistory: false,
        }),
      });
      if (!created.response.ok && created.response.status !== 409) {
        throw new Error(evoError(created.body, 'تعذّر إنشاء جلسة WhatsApp على Evolution'));
      }
    }

    const { data: savedAccount, error: accountError } = await supabase.from('social_accounts').upsert({
      workspace_id: workspaceId,
      platform: 'whatsapp',
      external_id: name,
      handle: account?.handle ?? 'WhatsApp Web',
      display_name: account?.display_name ?? 'WhatsApp',
      status: 'error',
      needs_reconnect: true,
      metadata: {
        ...(account?.metadata ?? {}),
        provider: 'evolution',
        integration: 'WHATSAPP-BAILEYS',
        instance_name: name,
        onboarding_state: 'scan_qr',
      },
      updated_at: new Date().toISOString(),
    }, { onConflict: 'workspace_id,platform' }).select().single();
    if (accountError || !savedAccount) throw new Error(accountError?.message ?? 'تعذّر حفظ جلسة WhatsApp');
    account = savedAccount;

    await supabase.from('social_account_tokens').upsert({
      account_id: account.id,
      access_token: 'evolution-provider',
      refresh_token: secret,
      token_type: 'provider_session',
      expires_at: null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'account_id' });

    await setWebhook(cfg, name, secret);

    let connect = await evoFetch(cfg, `/instance/connect/${encodeURIComponent(name)}`);
    if (!connect.response.ok && connect.response.status !== 409) {
      connect = await evoFetch(cfg, `/instance/connect/${encodeURIComponent(name)}`, { method: 'POST' });
    }
    if (!connect.response.ok && connect.response.status !== 409) {
      throw new Error(evoError(connect.body, 'تعذّر إنشاء QR لواتساب'));
    }

    const state = await connectionState(cfg, name);
    const qr = qrFrom(connect.body);
    const connected = ['open', 'connected'].includes(state.state);

    await supabase.from('social_accounts').update({
      status: connected ? 'connected' : 'error',
      needs_reconnect: !connected,
      last_sync_at: new Date().toISOString(),
      metadata: {
        ...(account.metadata ?? {}),
        provider: 'evolution',
        integration: 'WHATSAPP-BAILEYS',
        instance_name: name,
        onboarding_state: connected ? 'ready' : 'scan_qr',
        provider_state: state.state,
      },
    }).eq('id', account.id);

    return json(200, {
      ok: true,
      configured: true,
      connected,
      state: state.state,
      qrBase64: qr.base64,
      qrCode: qr.code,
      pairingCode: qr.pairingCode,
      accountId: account.id,
    });
  } catch (error) {
    return json(502, { error: error instanceof Error ? error.message : 'تعذّر تشغيل WhatsApp' });
  }
});
