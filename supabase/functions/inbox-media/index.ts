import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
  'Access-Control-Expose-Headers': 'Content-Type, Content-Length, Content-Disposition',
};
const GRAPH_VERSION = Deno.env.get('META_GRAPH_VERSION') ?? 'v26.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;
const MAX_BYTES = 32 * 1024 * 1024;

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } },
);

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: auth } = await supabase.auth.getUser(jwt);
  if (!auth.user) return json(401, { error: 'Unauthorized' });

  const body = await req.json().catch(() => ({})) as { messageId?: string };
  if (!body.messageId) return json(400, { error: 'messageId مطلوب' });

  const { data: message } = await supabase
    .from('inbox_messages')
    .select('id,workspace_id,conversation_id,metadata')
    .eq('id', body.messageId)
    .maybeSingle();
  if (!message) return json(404, { error: 'الرسالة غير موجودة' });

  const { data: membership } = await supabase
    .from('workspace_members')
    .select('id')
    .eq('workspace_id', message.workspace_id)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (!membership) return json(403, { error: 'Forbidden' });

  const { data: conversation } = await supabase
    .from('inbox_conversations')
    .select('account_id,platform')
    .eq('id', message.conversation_id)
    .maybeSingle();
  if (!conversation || conversation.platform !== 'whatsapp') {
    return json(400, { error: 'هذه الرسالة ليست ميديا WhatsApp' });
  }

  const metadata = (message.metadata ?? {}) as Record<string, unknown>;

  const storagePath = typeof metadata.storage_path === 'string' ? metadata.storage_path : '';
  if (storagePath) {
    const { data: stored, error: storageError } = await supabase.storage.from('inbox-media').download(storagePath);
    if (storageError || !stored) {
      return json(404, { error: storageError?.message ?? 'تعذّر تحميل المرفق المخزن' });
    }
    const contentType = typeof metadata.mime_type === 'string' && metadata.mime_type
      ? metadata.mime_type
      : stored.type || 'application/octet-stream';
    const filename = typeof metadata.filename === 'string' && metadata.filename
      ? metadata.filename.replace(/[\r\n"]/g, '_')
      : 'whatsapp-attachment';

    return new Response(stored.stream(), {
      status: 200,
      headers: {
        ...CORS,
        'Content-Type': contentType,
        'Content-Length': String(stored.size),
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'private, max-age=60',
      },
    });
  }

  const mediaId = typeof metadata.media_id === 'string' ? metadata.media_id : '';
  if (!mediaId) return json(404, { error: 'لا يوجد ملف محفوظ لهذه الرسالة' });

  const { data: tokenRow } = await supabase
    .from('social_account_tokens')
    .select('access_token,expires_at')
    .eq('account_id', conversation.account_id)
    .maybeSingle();
  if (!tokenRow?.access_token) return json(409, { error: 'حساب WhatsApp يحتاج إعادة ربط' });
  if (tokenRow.expires_at && new Date(tokenRow.expires_at).getTime() < Date.now() + 60_000) {
    return json(409, { error: 'انتهت صلاحية WhatsApp — أعد ربط الحساب' });
  }

  const metaResponse = await fetch(`${GRAPH}/${encodeURIComponent(mediaId)}`, {
    headers: { Authorization: `Bearer ${tokenRow.access_token}` },
  });
  const metaBody = await metaResponse.json().catch(() => ({})) as Record<string, unknown>;
  if (!metaResponse.ok || typeof metaBody.url !== 'string') {
    const apiError = metaBody.error as Record<string, unknown> | undefined;
    return json(metaResponse.status, {
      error: typeof apiError?.message === 'string' ? apiError.message : 'تعذّر الحصول على ملف WhatsApp',
    });
  }

  const fileSize = typeof metaBody.file_size === 'number' ? metaBody.file_size : null;
  if (fileSize !== null && fileSize > MAX_BYTES) {
    return json(413, { error: 'حجم الملف أكبر من حد المعاينة داخل SocialPilot' });
  }

  const mediaResponse = await fetch(metaBody.url, {
    headers: { Authorization: `Bearer ${tokenRow.access_token}` },
  });
  if (!mediaResponse.ok || !mediaResponse.body) {
    return json(mediaResponse.status, { error: 'تعذّر تنزيل ملف WhatsApp من Meta' });
  }

  const contentLength = Number(mediaResponse.headers.get('content-length') ?? fileSize ?? 0);
  if (contentLength > MAX_BYTES) return json(413, { error: 'حجم الملف أكبر من حد المعاينة داخل SocialPilot' });

  const contentType =
    mediaResponse.headers.get('content-type')
    || (typeof metaBody.mime_type === 'string' ? metaBody.mime_type : null)
    || (typeof metadata.mime_type === 'string' ? metadata.mime_type : null)
    || 'application/octet-stream';
  const filename = typeof metadata.filename === 'string' && metadata.filename
    ? metadata.filename.replace(/[\r\n"]/g, '_')
    : `whatsapp-${mediaId}`;

  return new Response(mediaResponse.body, {
    status: 200,
    headers: {
      ...CORS,
      'Content-Type': contentType,
      ...(contentLength > 0 ? { 'Content-Length': String(contentLength) } : {}),
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'private, max-age=60',
    },
  });
});
