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

function safeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120) || 'attachment';
}

function participant(value: string): string {
  return value.replace(/@(c|s\.whatsapp)\.us$/i, '');
}

function messageIdOf(value: Record<string, unknown>): string {
  if (typeof value.id === 'string') return value.id;
  const id = value.id as Record<string, unknown> | undefined;
  if (typeof id?._serialized === 'string') return id._serialized;
  if (typeof id?.id === 'string') return id.id;
  if (typeof value.messageId === 'string') return value.messageId;
  if (typeof value.msgId === 'string') return value.msgId;
  return '';
}

function mediaType(payload: Record<string, unknown>): string {
  const type = String(payload.type ?? payload.mediatype ?? '').toLowerCase();
  const mime = String(payload.mimetype ?? payload.mimeType ?? '').toLowerCase();
  if (type.includes('image') || mime.startsWith('image/')) return 'image';
  if (type.includes('video') || mime.startsWith('video/')) return 'video';
  if (type.includes('audio') || type.includes('ptt') || mime.startsWith('audio/')) return 'audio';
  if (type.includes('sticker')) return 'sticker';
  if (type.includes('document') || mime) return 'document';
  return 'text';
}

function ackStatus(payload: Record<string, unknown>): string | null {
  const raw = payload.ack ?? payload.status ?? payload.acknowledgement;
  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    if (numeric < 0) return 'failed';
    if (numeric === 0) return 'accepted';
    if (numeric === 1) return 'sent';
    if (numeric === 2) return 'delivered';
    if (numeric >= 3) return 'read';
  }
  const value = String(raw ?? '').toLowerCase();
  if (value.includes('error') || value.includes('fail')) return 'failed';
  if (value.includes('pending')) return 'accepted';
  if (value.includes('server') || value.includes('sent')) return 'sent';
  if (value.includes('device') || value.includes('deliver')) return 'delivered';
  if (value.includes('read') || value.includes('play')) return 'read';
  return null;
}

function decodeBase64(value: string): Uint8Array | null {
  try {
    const raw = value.includes(',') ? value.slice(value.indexOf(',') + 1) : value;
    const binary = atob(raw);
    if (binary.length > MAX_MEDIA_BYTES) return null;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function storeBytes(params: {
  accountId: string;
  workspaceId: string;
  messageId: string;
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}) {
  if (params.bytes.byteLength > MAX_MEDIA_BYTES) return { media_download_error: 'media_too_large' };
  const path = `${params.workspaceId}/${params.accountId}/${params.messageId}/${safeName(params.filename)}`;
  const { error } = await supabase.storage.from('inbox-media').upload(path, params.bytes, {
    contentType: params.mimeType,
    upsert: true,
  });
  if (error) return { media_download_error: error.message };
  return {
    storage_path: path,
    filename: params.filename,
    mime_type: params.mimeType,
    file_size: params.bytes.byteLength,
  };
}

async function fetchMedia(params: {
  accountId: string;
  workspaceId: string;
  session: string;
  bearer: string;
  baseUrl: string;
  messageId: string;
  payload: Record<string, unknown>;
}): Promise<Record<string, unknown>> {
  const mimeType = String(params.payload.mimetype ?? params.payload.mimeType ?? 'application/octet-stream');
  const filename = String(params.payload.filename ?? params.payload.fileName ?? `${params.messageId}.${mediaType(params.payload)}`);

  const inline = [
    params.payload.base64,
    params.payload.fileBase64,
    params.payload.data,
  ].find((value) => typeof value === 'string' && value.length > 100) as string | undefined;
  if (inline) {
    const bytes = decodeBase64(inline);
    if (bytes) return storeBytes({
      accountId: params.accountId,
      workspaceId: params.workspaceId,
      messageId: params.messageId,
      bytes,
      filename,
      mimeType,
    });
  }

  const endpoints: Array<{ url: string; init: RequestInit }> = [
    {
      url: `${params.baseUrl}/api/${encodeURIComponent(params.session)}/get-media-by-message/${encodeURIComponent(params.messageId)}`,
      init: {},
    },
    {
      url: `${params.baseUrl}/api/${encodeURIComponent(params.session)}/download-media`,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: params.messageId }),
      },
    },
  ];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint.url, {
        ...endpoint.init,
        headers: {
          Authorization: `Bearer ${params.bearer}`,
          Accept: '*/*',
          ...(endpoint.init.headers ?? {}),
        },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) continue;

      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('application/json')) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > 0 && bytes.byteLength <= MAX_MEDIA_BYTES) {
          return storeBytes({
            accountId: params.accountId,
            workspaceId: params.workspaceId,
            messageId: params.messageId,
            bytes,
            filename,
            mimeType: contentType || mimeType,
          });
        }
        continue;
      }

      const body = await response.json().catch(() => ({})) as Record<string, unknown>;
      const candidate = [
        body.base64,
        body.data,
        body.file,
        (body.response as Record<string, unknown> | undefined)?.base64,
      ].find((value) => typeof value === 'string' && value.length > 100) as string | undefined;
      if (!candidate) continue;
      const bytes = decodeBase64(candidate);
      if (!bytes) continue;
      return storeBytes({
        accountId: params.accountId,
        workspaceId: params.workspaceId,
        messageId: params.messageId,
        bytes,
        filename: typeof body.filename === 'string' ? body.filename : filename,
        mimeType: typeof body.mimetype === 'string' ? body.mimetype : mimeType,
      });
    } catch {
      // Try next media endpoint.
    }
  }

  return { filename, mime_type: mimeType, media_download_error: 'wppconnect_media_download_failed' };
}

function eventPayload(root: Record<string, unknown>): Record<string, unknown> {
  const body = root.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) return body as Record<string, unknown>;
  const response = root.response;
  if (response && typeof response === 'object' && !Array.isArray(response)) return response as Record<string, unknown>;
  const data = root.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) return data as Record<string, unknown>;
  return root;
}

async function upsertInbound(params: {
  account: Record<string, unknown>;
  payload: Record<string, unknown>;
  session: string;
  bearer: string;
  baseUrl: string;
}) {
  const id = messageIdOf(params.payload);
  const from = String(params.payload.from ?? params.payload.author ?? '');
  if (!id || !from || from === 'status@broadcast') return;
  if (params.payload.fromMe === true || params.payload.isSentByMe === true) return;

  const workspaceId = String(params.account.workspace_id);
  const accountId = String(params.account.id);
  const type = mediaType(params.payload);
  const body = typeof params.payload.body === 'string'
    ? params.payload.body.trim()
    : typeof params.payload.caption === 'string'
      ? params.payload.caption.trim()
      : '';
  const filename = typeof params.payload.filename === 'string'
    ? params.payload.filename
    : typeof params.payload.fileName === 'string'
      ? params.payload.fileName
      : null;
  const content = body || (type !== 'text'
    ? `[${type === 'image' ? 'صورة' : type === 'video' ? 'فيديو' : type === 'audio' ? 'رسالة صوتية' : type === 'sticker' ? 'ملصق' : 'ملف'}${filename ? `: ${filename}` : ''}]`
    : '[رسالة WhatsApp]');
  const isGroup = from.endsWith('@g.us');
  const senderName = String(params.payload.sender?.pushname ?? params.payload.senderName ?? params.payload.notifyName ?? participant(from));

  const { data: conversation, error: conversationError } = await supabase.from('inbox_conversations').upsert({
    workspace_id: workspaceId,
    account_id: accountId,
    platform: 'whatsapp',
    type: 'dm',
    external_id: from,
    external_participant_id: from,
    sender_name: senderName,
    snippet: content,
    unread: true,
    status: 'open',
    resolved_at: null,
    metadata: {
      provider: 'wppconnect',
      remote_jid: from,
      is_group: isGroup,
    },
  }, { onConflict: 'account_id,platform,type,external_id' }).select('id').single();

  if (conversationError || !conversation) {
    console.error('WPPConnect conversation upsert failed', conversationError?.message);
    return;
  }

  let mediaMetadata: Record<string, unknown> = {};
  if (type !== 'text' && type !== 'sticker') {
    mediaMetadata = await fetchMedia({
      accountId,
      workspaceId,
      session: params.session,
      bearer: params.bearer,
      baseUrl: params.baseUrl,
      messageId: id,
      payload: params.payload,
    });
  }

  const rawTimestamp = Number(params.payload.timestamp ?? params.payload.t ?? 0);
  const timestamp = Number.isFinite(rawTimestamp) && rawTimestamp > 0
    ? new Date(rawTimestamp > 10_000_000_000 ? rawTimestamp : rawTimestamp * 1000).toISOString()
    : new Date().toISOString();

  const { data: inserted, error: messageError } = await supabase.from('inbox_messages').upsert({
    workspace_id: workspaceId,
    conversation_id: conversation.id,
    direction: 'inbound',
    content,
    is_ai: false,
    external_id: id,
    sender_external_id: participant(from),
    sender_name: senderName,
    created_at: timestamp,
    metadata: {
      source: 'wppconnect_webhook',
      provider: 'wppconnect',
      message_type: type,
      remote_jid: from,
      ...mediaMetadata,
    },
  }, { onConflict: 'conversation_id,external_id', ignoreDuplicates: true }).select('id').maybeSingle();

  if (messageError) {
    console.error('WPPConnect message upsert failed', messageError.message);
    return;
  }
  if (inserted) {
    await supabase.from('notifications').insert({
      workspace_id: workspaceId,
      type: 'inbox_new_message',
      title: `رسالة WhatsApp جديدة من ${senderName}`,
      body: content.length > 140 ? `${content.slice(0, 140)}…` : content,
      payload: { conversation_id: conversation.id, platform: 'whatsapp', inbox_type: 'dm' },
    });
  }
}

async function applyAck(account: Record<string, unknown>, payload: Record<string, unknown>) {
  const id = messageIdOf(payload);
  const status = ackStatus(payload);
  if (!id || !status) return;

  const { data: row } = await supabase.from('inbox_messages')
    .select('id,metadata')
    .eq('workspace_id', account.workspace_id)
    .eq('external_id', id)
    .eq('direction', 'outbound')
    .maybeSingle();
  if (!row) return;

  const rank: Record<string, number> = { accepted: 0, sent: 1, delivered: 2, read: 3 };
  const previous = typeof row.metadata?.delivery_status === 'string' ? row.metadata.delivery_status : null;
  if (status !== 'failed' && previous && (rank[previous] ?? -1) > (rank[status] ?? -1)) return;
  if (previous === 'read' && status === 'failed') return;

  await supabase.from('inbox_messages').update({
    metadata: {
      ...(row.metadata ?? {}),
      delivery_status: status,
      delivery_status_at: new Date().toISOString(),
      provider_update: payload,
    },
  }).eq('id', row.id);
}

function isConnectedStatus(value: unknown): boolean {
  const state = String(value ?? '').toLowerCase();
  return state.includes('connected') || state.includes('logged') || state === 'inchat' || state === 'ischat' || state === 'open';
}

async function providerBaseUrl(): Promise<string> {
  const { data: secret } = await supabase.from('social_platform_app_secrets')
    .select('app_secret')
    .eq('platform_key', 'whatsapp')
    .maybeSingle();
  if (!secret?.app_secret) throw new Error('WhatsApp provider registry missing');
  const bundle = JSON.parse(String(secret.app_secret)) as {
    version?: number;
    providers?: { wppconnect?: { baseUrl?: string } };
  };
  const baseUrl = bundle.providers?.wppconnect?.baseUrl;
  if (!baseUrl) throw new Error('WPPConnect base URL missing');
  return baseUrl.replace(/\/+$/, '');
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const url = new URL(req.url);
  const session = url.searchParams.get('session') ?? '';
  const suppliedSecret = url.searchParams.get('secret') ?? '';
  if (!session || !suppliedSecret) return json(401, { error: 'Missing webhook credentials' });

  const { data: account } = await supabase.from('social_accounts')
    .select('id,workspace_id,status,metadata')
    .eq('platform', 'whatsapp')
    .contains('metadata', { provider: 'wppconnect', instance_name: session })
    .maybeSingle();
  if (!account) return json(200, { ok: true, ignored: true, reason: 'unknown_session' });

  const { data: tokenRow } = await supabase.from('social_account_tokens')
    .select('access_token,refresh_token')
    .eq('account_id', account.id)
    .maybeSingle();
  const webhookSecret = typeof tokenRow?.refresh_token === 'string' ? tokenRow.refresh_token : '';
  const bearer = typeof tokenRow?.access_token === 'string' ? tokenRow.access_token : '';
  if (!webhookSecret || suppliedSecret !== webhookSecret || !bearer) return json(401, { error: 'Invalid webhook secret' });

  const root = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!root) return json(400, { error: 'Invalid JSON' });
  const event = String(root.event ?? root.type ?? '').toLowerCase();
  const payload = eventPayload(root);

  try {
    if (event === 'onmessage' || event === 'message' || event === 'message.received') {
      await upsertInbound({
        account,
        payload,
        session,
        bearer,
        baseUrl: await providerBaseUrl(),
      });
      return json(200, { ok: true });
    }

    if (event === 'onack' || event === 'ack' || event === 'message.ack') {
      await applyAck(account, payload);
      return json(200, { ok: true });
    }

    if (
      event === 'status-find'
      || event === 'session.status'
      || event === 'state.change'
      || event === 'onstatechange'
    ) {
      const rawState = payload.status ?? payload.state ?? payload.sessionStatus ?? root.status;
      const connected = isConnectedStatus(rawState);
      await supabase.from('social_accounts').update({
        status: connected ? 'connected' : 'error',
        needs_reconnect: !connected,
        last_sync_at: new Date().toISOString(),
        metadata: {
          ...(account.metadata ?? {}),
          provider_state: String(rawState ?? 'unknown'),
          onboarding_state: connected ? 'ready' : 'scan_qr',
        },
      }).eq('id', account.id);
      return json(200, { ok: true });
    }

    return json(200, { ok: true, ignored: true, event });
  } catch (error) {
    console.error('whatsapp-wppconnect-webhook failed', error);
    return json(500, { error: error instanceof Error ? error.message : 'WPPConnect webhook failed' });
  }
});
