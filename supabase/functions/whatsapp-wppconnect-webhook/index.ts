import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } },
);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function providerConfig(): Promise<{ baseUrl: string }> {
  const { data: app } = await supabase.from('social_platform_apps')
    .select('app_id,enabled,status')
    .eq('platform_key', 'whatsapp_wppconnect')
    .maybeSingle();
  if (!app?.enabled || app.status !== 'connected' || !app.app_id) {
    throw new Error('WPPConnect provider غير مُعد');
  }
  return { baseUrl: String(app.app_id).trim().replace(/\/+$/, '') };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function messageId(value: unknown): string {
  if (typeof value === 'string') return value;
  const record = object(value);
  return stringValue(record._serialized, record.id);
}

function normalizeJid(value: string): string {
  if (!value) return '';
  if (value.includes('@')) return value;
  return `${value.replace(/\D/g, '')}@c.us`;
}

function participantFromJid(value: string): string {
  return value.replace(/@(c|s)\.us$/i, '').replace(/@lid$/i, '');
}

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'attachment';
}

function deliveryStatus(raw: unknown): string | null {
  if (typeof raw === 'number') {
    const map: Record<number, string> = { [-1]: 'failed', 0: 'accepted', 1: 'sent', 2: 'delivered', 3: 'read', 4: 'read' };
    return map[raw] ?? null;
  }
  const value = String(raw ?? '').toUpperCase();
  if (!value) return null;
  if (value.includes('ERROR') || value.includes('FAIL')) return 'failed';
  if (value.includes('READ') || value.includes('PLAY')) return 'read';
  if (value.includes('DELIVER')) return 'delivered';
  if (value.includes('SENT') || value.includes('SERVER')) return 'sent';
  if (value.includes('PENDING')) return 'accepted';
  return null;
}

function decodeBase64(value: string): Uint8Array {
  const raw = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value;
  const binary = atob(raw);
  if (binary.length > MAX_MEDIA_BYTES) throw new Error('media_too_large');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function downloadAndStoreMedia(params: {
  baseUrl: string;
  session: string;
  token: string;
  workspaceId: string;
  accountId: string;
  externalId: string;
  messagePayload: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  try {
    const response = await fetch(
      `${params.baseUrl}/api/${encodeURIComponent(params.session)}/download-media`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${params.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ messageId: params.externalId }),
      },
    );
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) {
      return { media_download_error: `WPPConnect media HTTP ${response.status}`, provider_media: body };
    }

    const result = object(body.result);
    const media = object(body.media);
    const base64 = stringValue(body.base64, body.data, result.base64, result.data, media.base64, media.data);
    if (!base64) return { media_download_error: 'WPPConnect did not return base64 media', provider_media: body };

    const mimeType = stringValue(
      body.mimetype,
      body.mimeType,
      result.mimetype,
      result.mimeType,
      media.mimetype,
      params.messagePayload.mimetype,
    ) || 'application/octet-stream';
    const originalName = stringValue(
      body.filename,
      result.filename,
      media.filename,
      params.messagePayload.filename,
    );
    const extension = mimeType.split('/')[1]?.split(';')[0] || 'bin';
    const filename = originalName || `${params.externalId}.${extension}`;
    const bytes = decodeBase64(base64);
    const path = `${params.workspaceId}/${params.accountId}/${params.externalId}/${safeName(filename)}`;

    const { error } = await supabase.storage.from('inbox-media').upload(path, bytes, {
      contentType: mimeType,
      upsert: true,
    });
    if (error) return { media_download_error: error.message, provider_media: body };

    return {
      storage_path: path,
      filename,
      mime_type: mimeType,
      file_size: bytes.byteLength,
    };
  } catch (error) {
    return {
      media_download_error: error instanceof Error ? error.message : 'media_download_failed',
    };
  }
}

async function identifyAccount(secret: string) {
  const { data: token } = await supabase.from('social_account_tokens')
    .select('account_id,access_token,refresh_token')
    .eq('refresh_token', secret)
    .maybeSingle();
  if (!token?.account_id || token.refresh_token !== secret) return null;

  const { data: account } = await supabase.from('social_accounts')
    .select('id,workspace_id,status,metadata,external_id')
    .eq('id', token.account_id)
    .eq('platform', 'whatsapp')
    .maybeSingle();
  if (!account || account.metadata?.provider !== 'wppconnect') return null;
  return { account, token };
}

function normalizedEvent(payload: Record<string, unknown>): { event: string; data: Record<string, unknown> } {
  const rootBody = object(payload.body);
  const data = Object.keys(rootBody).length > 0 && typeof rootBody.event === 'string'
    ? rootBody
    : Object.keys(object(payload.data)).length > 0
      ? object(payload.data)
      : payload;
  const event = stringValue(payload.event, rootBody.event, data.event).toLowerCase();
  return { event, data };
}

async function processStatus(account: Record<string, unknown>, data: Record<string, unknown>) {
  const raw = stringValue(data.status, data.state, data.connectionState, data.message);
  const state = raw.toUpperCase() || 'UNKNOWN';
  const connected = ['ISLOGGED', 'INCHAT', 'CONNECTED', 'OPEN'].some((value) => state.includes(value));

  await supabase.from('social_accounts').update({
    status: connected ? 'connected' : 'error',
    needs_reconnect: !connected,
    last_sync_at: new Date().toISOString(),
    metadata: {
      ...(account.metadata ?? {}),
      provider: 'wppconnect',
      provider_state: state,
      onboarding_state: connected ? 'ready' : 'scan_qr',
    },
    updated_at: new Date().toISOString(),
  }).eq('id', account.id);
}

async function processAck(account: Record<string, unknown>, data: Record<string, unknown>) {
  const externalId = messageId(data.id ?? data.messageId);
  const next = deliveryStatus(data.ack ?? data.status);
  if (!externalId || !next) return;

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
      delivery_status: next,
      delivery_status_at: new Date().toISOString(),
      provider_ack: data.ack ?? data.status ?? null,
    },
  }).eq('id', row.id);
}

async function processMessage(
  account: Record<string, unknown>,
  token: Record<string, unknown>,
  payload: Record<string, unknown>,
) {
  const externalId = messageId(payload.id ?? payload.messageId);
  if (!externalId) return;

  const fromMe = payload.fromMe === true || payload.self === 'out' || payload.self === true;
  const from = stringValue(payload.from, object(payload.sender).id, object(payload.author).id);
  const to = stringValue(payload.to);
  const chatId = normalizeJid(stringValue(payload.chatId, fromMe ? to : from));
  if (!chatId || chatId === 'status@broadcast') return;

  const type = stringValue(payload.type, payload.mimetype ? 'document' : 'chat').toLowerCase();
  const body = stringValue(payload.body, payload.caption, payload.text)
    || (type === 'chat' || type === 'text' ? '[رسالة WhatsApp]' : '[مرفق WhatsApp]');
  const isGroup = chatId.endsWith('@g.us');
  const participant = participantFromJid(chatId);
  const senderName = stringValue(
    payload.notifyName,
    payload.pushName,
    object(payload.sender).name,
    participant,
  );

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
      provider: 'wppconnect',
      remote_jid: chatId,
      is_group: isGroup,
    },
  }, { onConflict: 'account_id,platform,type,external_id' }).select('id').single();

  if (convError || !conversation) {
    console.error('WPPConnect conversation upsert failed', convError?.message);
    return;
  }

  let mediaMetadata: Record<string, unknown> = {};
  const isMedia = !['chat', 'text', 'ciphertext', 'notification'].includes(type);
  if (isMedia && typeof token.access_token === 'string') {
    const cfg = await providerConfig();
    const session = stringValue(account.metadata?.instance_name, payload.session);
    if (session) {
      mediaMetadata = await downloadAndStoreMedia({
        baseUrl: cfg.baseUrl,
        session,
        token: token.access_token,
        workspaceId,
        accountId,
        externalId,
        messagePayload: payload,
      });
    }
  }

  const rawTime = Number(payload.t ?? payload.timestamp ?? 0);
  const createdAt = Number.isFinite(rawTime) && rawTime > 0
    ? new Date(rawTime > 10_000_000_000 ? rawTime : rawTime * 1000).toISOString()
    : new Date().toISOString();

  const messageType =
    type === 'chat' ? 'text'
    : type.includes('image') ? 'image'
    : type.includes('video') ? 'video'
    : type.includes('audio') || type.includes('ptt') ? 'audio'
    : type.includes('sticker') ? 'sticker'
    : type.includes('location') ? 'location'
    : type.includes('vcard') || type.includes('contact') ? 'contact'
    : isMedia ? 'document'
    : 'text';

  const { data: inserted, error: msgError } = await supabase.from('inbox_messages').upsert({
    workspace_id: workspaceId,
    conversation_id: conversation.id,
    direction: fromMe ? 'outbound' : 'inbound',
    content: body,
    is_ai: false,
    external_id: externalId,
    sender_external_id: fromMe ? null : participant,
    sender_name: fromMe ? 'أنت' : senderName,
    created_at: createdAt,
    metadata: {
      source: 'wppconnect_webhook',
      provider: 'wppconnect',
      message_type: messageType,
      remote_jid: chatId,
      provider_ack: payload.ack ?? null,
      ...mediaMetadata,
    },
  }, { onConflict: 'conversation_id,external_id', ignoreDuplicates: true }).select('id').maybeSingle();

  if (msgError) {
    console.error('WPPConnect message upsert failed', msgError.message);
    return;
  }

  if (inserted && !fromMe) {
    await supabase.from('notifications').insert({
      workspace_id: workspaceId,
      type: 'inbox_new_message',
      title: `رسالة WhatsApp جديدة من ${senderName}`,
      body: body.length > 140 ? `${body.slice(0, 140)}…` : body,
      payload: { conversation_id: conversation.id, platform: 'whatsapp', provider: 'wppconnect' },
    });
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const url = new URL(req.url);
  const secret = url.searchParams.get('secret') ?? '';
  if (!secret || secret.length < 32) return json(401, { error: 'Missing webhook secret' });

  const identified = await identifyAccount(secret);
  if (!identified) return json(401, { error: 'Invalid webhook secret' });

  const payload = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!payload) return json(400, { error: 'Invalid JSON' });

  const { event, data } = normalizedEvent(payload);

  try {
    if (
      event === 'status-find'
      || event === 'status'
      || event === 'state-change'
      || event === 'session-status'
      || event === 'onstatechange'
    ) {
      await processStatus(identified.account, data);
      return json(200, { ok: true });
    }

    if (event === 'onack' || event === 'ack' || event === 'message_ack') {
      await processAck(identified.account, data);
      return json(200, { ok: true });
    }

    if (
      event === 'onmessage'
      || event === 'message'
      || event === 'onanymessage'
      || (!event && (data.from || data.chatId) && data.id)
    ) {
      await processMessage(identified.account, identified.token, data);
      return json(200, { ok: true });
    }

    return json(200, { ok: true, ignored: true, event });
  } catch (error) {
    console.error('WPPConnect webhook failed', error);
    return json(500, { error: error instanceof Error ? error.message : 'WPPConnect webhook processing failed' });
  }
});
