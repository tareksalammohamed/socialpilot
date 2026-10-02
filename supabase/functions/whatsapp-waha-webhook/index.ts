import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Webhook-Hmac, X-Webhook-Hmac-Algorithm',
};
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const supabaseUrl = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyHmac(raw: string, secret: string, supplied: string): Promise<boolean> {
  if (!secret || !supplied) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
  return timingSafeEqualHex(bytesToHex(signature), supplied.toLowerCase());
}

async function providerConfig() {
  const [{ data: app }, { data: secret }] = await Promise.all([
    supabase.from('social_platform_apps').select('app_id,enabled,status').eq('platform_key', 'whatsapp_waha').maybeSingle(),
    supabase.from('social_platform_app_secrets').select('app_secret').eq('platform_key', 'whatsapp_waha').maybeSingle(),
  ]);
  if (!app?.enabled || app.status !== 'connected' || !app.app_id || !secret?.app_secret) {
    throw new Error('WAHA provider غير مُعد');
  }
  return {
    baseUrl: String(app.app_id).replace(/\/+$/, ''),
    apiKey: String(secret.app_secret),
  };
}

function externalParticipant(value: string): string {
  return value.replace(/@(c|s)\.us$/i, '');
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'attachment';
}

function messageId(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record._serialized === 'string') return record._serialized;
    if (typeof record.id === 'string') return record.id;
  }
  return '';
}

function deliveryStatus(raw: unknown): string | null {
  const numeric: Record<number, string> = {
    [-1]: 'failed',
    0: 'accepted',
    1: 'sent',
    2: 'delivered',
    3: 'read',
    4: 'read',
  };
  if (typeof raw === 'number') return numeric[raw] ?? null;
  const value = String(raw ?? '').toUpperCase();
  if (value.includes('ERROR') || value.includes('FAILED')) return 'failed';
  if (value.includes('READ') || value.includes('PLAY')) return 'read';
  if (value.includes('DELIVER')) return 'delivered';
  if (value.includes('SENT') || value.includes('SERVER')) return 'sent';
  if (value.includes('PENDING')) return 'accepted';
  return null;
}

function scheduleAutoReply(inboundMessageId: string) {
  if (!supabaseUrl || !serviceRoleKey) return;
  EdgeRuntime.waitUntil(
    fetch(`${supabaseUrl}/functions/v1/inbox-auto-reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
      },
      body: JSON.stringify({ inboundMessageId }),
    }).catch((error) => console.error('WAHA auto-reply trigger failed', error)),
  );
}

async function storeMedia(params: {
  cfg: { baseUrl: string; apiKey: string };
  url: string;
  workspaceId: string;
  accountId: string;
  externalId: string;
  filename: string;
  mimeType: string | null;
}): Promise<Record<string, unknown>> {
  try {
    let mediaUrl = new URL(params.url, params.cfg.baseUrl);
    if (['localhost', '127.0.0.1'].includes(mediaUrl.hostname)) {
      const publicBase = new URL(params.cfg.baseUrl);
      mediaUrl = new URL(mediaUrl.pathname + mediaUrl.search, publicBase);
    }
    const response = await fetch(mediaUrl, { headers: { 'X-Api-Key': params.cfg.apiKey } });
    if (!response.ok) return { media_download_error: `WAHA media HTTP ${response.status}`, provider_media_url: params.url };

    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > MAX_MEDIA_BYTES) return { media_download_error: 'media_too_large', provider_media_url: params.url };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_MEDIA_BYTES) return { media_download_error: 'media_too_large', provider_media_url: params.url };

    const path = `${params.workspaceId}/${params.accountId}/${params.externalId}/${safeName(params.filename)}`;
    const { error } = await supabase.storage.from('inbox-media').upload(path, bytes, {
      contentType: params.mimeType ?? response.headers.get('content-type') ?? 'application/octet-stream',
      upsert: true,
    });
    if (error) return { media_download_error: error.message, provider_media_url: params.url };
    return {
      storage_path: path,
      filename: params.filename,
      mime_type: params.mimeType ?? response.headers.get('content-type'),
      file_size: bytes.byteLength,
    };
  } catch (error) {
    return { media_download_error: error instanceof Error ? error.message : 'media_download_failed', provider_media_url: params.url };
  }
}

async function processMessage(account: Record<string, unknown>, payload: Record<string, unknown>) {
  const externalId = messageId(payload.id);
  if (!externalId) return;

  const fromMe = payload.fromMe === true;
  const from = typeof payload.from === 'string' ? payload.from : '';
  const to = typeof payload.to === 'string' ? payload.to : '';
  const chatId = typeof payload.chatId === 'string' ? payload.chatId : (fromMe ? to : from);
  if (!chatId || chatId === 'status@broadcast') return;

  const isGroup = chatId.endsWith('@g.us');
  const participant = externalParticipant(chatId);
  const body = typeof payload.body === 'string' && payload.body.trim()
    ? payload.body.trim()
    : payload.hasMedia === true
      ? '[مرفق WhatsApp]'
      : '[رسالة WhatsApp]';
  const senderName = typeof payload.notifyName === 'string'
    ? payload.notifyName
    : typeof payload.pushName === 'string'
      ? payload.pushName
      : participant;
  const workspaceId = String(account.workspace_id);
  const accountId = String(account.id);

  const { data: conversation, error: convError } = await supabase.from('inbox_conversations').upsert({
    workspace_id: workspaceId,
    account_id: accountId,
    platform: 'whatsapp',
    type: 'dm',
    external_id: chatId,
    external_participant_id: chatId,
    sender_name: senderName,
    snippet: body,
    unread: !fromMe,
    status: 'open',
    resolved_at: null,
    metadata: {
      provider: 'waha',
      remote_jid: chatId,
      is_group: isGroup,
    },
  }, { onConflict: 'account_id,platform,type,external_id' }).select('id').single();
  if (convError || !conversation) {
    console.error('WAHA conversation upsert failed', convError?.message);
    return;
  }

  const media = (payload.media ?? {}) as Record<string, unknown>;
  const mediaUrl = typeof media.url === 'string' ? media.url : '';
  const mimeType = typeof media.mimetype === 'string' ? media.mimetype : null;
  const filename = typeof media.filename === 'string' && media.filename
    ? media.filename
    : `${externalId}.${mimeType?.split('/')[1]?.split(';')[0] ?? 'bin'}`;
  let mediaMetadata: Record<string, unknown> = {};
  if (payload.hasMedia === true && mediaUrl) {
    const cfg = await providerConfig();
    mediaMetadata = await storeMedia({
      cfg,
      url: mediaUrl,
      workspaceId,
      accountId,
      externalId,
      filename,
      mimeType,
    });
  }

  const timestamp = typeof payload.timestamp === 'number'
    ? new Date(payload.timestamp * 1000).toISOString()
    : new Date().toISOString();
  const messageType = typeof payload.type === 'string'
    ? (payload.type === 'chat' ? 'text' : payload.type)
    : payload.hasMedia === true ? 'document' : 'text';

  const { data: inserted, error: msgError } = await supabase.from('inbox_messages').upsert({
    workspace_id: workspaceId,
    conversation_id: conversation.id,
    direction: fromMe ? 'outbound' : 'inbound',
    content: body,
    is_ai: false,
    external_id: externalId,
    sender_external_id: fromMe ? null : participant,
    sender_name: fromMe ? 'أنت' : senderName,
    created_at: timestamp,
    metadata: {
      source: 'waha_webhook',
      provider: 'waha',
      message_type: messageType,
      remote_jid: chatId,
      provider_ack: payload.ack ?? null,
      ...mediaMetadata,
    },
  }, { onConflict: 'conversation_id,external_id', ignoreDuplicates: true }).select('id').maybeSingle();

  if (msgError) {
    console.error('WAHA message upsert failed', msgError.message);
    return;
  }

  if (inserted && !fromMe) {
    await supabase.from('notifications').insert({
      workspace_id: workspaceId,
      type: 'inbox_new_message',
      title: `رسالة WhatsApp جديدة من ${senderName}`,
      body: body.length > 140 ? `${body.slice(0, 140)}…` : body,
      payload: { conversation_id: conversation.id, platform: 'whatsapp', provider: 'waha' },
    });
    scheduleAutoReply(inserted.id);
  }
}

async function processAck(account: Record<string, unknown>, payload: Record<string, unknown>) {
  const externalId = messageId(payload.id ?? payload.messageId);
  const status = deliveryStatus(payload.ack ?? payload.status);
  if (!externalId || !status) return;

  const { data: row } = await supabase.from('inbox_messages')
    .select('id,metadata,conversation_id')
    .eq('workspace_id', account.workspace_id)
    .eq('external_id', externalId)
    .eq('direction', 'outbound')
    .maybeSingle();
  if (!row) return;

  await supabase.from('inbox_messages').update({
    metadata: {
      ...(row.metadata ?? {}),
      delivery_status: status,
      delivery_status_at: new Date().toISOString(),
      provider_ack: payload.ack ?? payload.status ?? null,
    },
  }).eq('id', row.id);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const raw = await req.text();
  const payload = JSON.parse(raw || '{}') as Record<string, unknown>;
  const session = typeof payload.session === 'string' ? payload.session : '';
  if (!session) return json(200, { ok: true, ignored: true, reason: 'missing_session' });

  const { data: account } = await supabase.from('social_accounts')
    .select('id,workspace_id,status,metadata')
    .eq('platform', 'whatsapp')
    .contains('metadata', { provider: 'waha', instance_name: session })
    .maybeSingle();
  if (!account) return json(200, { ok: true, ignored: true, reason: 'unknown_session' });

  const { data: token } = await supabase.from('social_account_tokens')
    .select('refresh_token')
    .eq('account_id', account.id)
    .maybeSingle();
  const supplied = req.headers.get('x-webhook-hmac') ?? '';
  if (!token?.refresh_token || !await verifyHmac(raw, String(token.refresh_token), supplied)) {
    return json(401, { error: 'Invalid WAHA webhook HMAC' });
  }

  const event = String(payload.event ?? '').toLowerCase();
  const eventPayload = (payload.payload ?? {}) as Record<string, unknown>;

  try {
    if (event === 'session.status') {
      const state = String(eventPayload.status ?? 'UNKNOWN').toUpperCase();
      const connected = state === 'WORKING';
      const me = (payload.me ?? {}) as Record<string, unknown>;
      const meId = typeof me.id === 'string' ? me.id : '';
      await supabase.from('social_accounts').update({
        status: connected ? 'connected' : 'error',
        needs_reconnect: !connected,
        ...(meId ? {
          external_id: meId,
          handle: externalParticipant(meId),
          display_name: typeof me.pushName === 'string' ? me.pushName : externalParticipant(meId),
        } : {}),
        last_sync_at: new Date().toISOString(),
        metadata: {
          ...(account.metadata ?? {}),
          provider: 'waha',
          provider_state: state,
          onboarding_state: connected ? 'ready' : state === 'SCAN_QR_CODE' ? 'scan_qr' : 'reconnect',
          engine: payload.engine ?? null,
        },
      }).eq('id', account.id);
      return json(200, { ok: true });
    }

    if (event === 'message.any') {
      await processMessage(account, eventPayload);
      return json(200, { ok: true });
    }

    if (event === 'message.ack') {
      await processAck(account, eventPayload);
      return json(200, { ok: true });
    }

    return json(200, { ok: true, ignored: true, event });
  } catch (error) {
    console.error('WAHA webhook failed', error);
    return json(500, { error: error instanceof Error ? error.message : 'WAHA webhook processing failed' });
  }
});
