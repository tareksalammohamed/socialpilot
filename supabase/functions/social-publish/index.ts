import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

// ---------------------------------------------------------------------------
// Called by a logged-in workspace member from "المحتوى" (or the calendar)
// to actually push a content_variant to its platform. This is the piece
// that was missing: social-oauth-* only *connects* accounts, nothing ever
// called the platform's API to post. This function:
//   1. Verifies the caller belongs to the workspace and the variant exists.
//   2. Opens/reuses a `publishing_jobs` row (idempotent by variant/calendar
//      item — clicking twice or retrying a failed job never double-posts).
//   3. Actually calls the platform API (Telegram bot API / X API v2).
//   4. Writes the outcome back to the database: publishing_jobs, the
//      calendar_item (if scheduled), content.status, a notification, and
//      an audit_log row.
//
// Real posting helpers exist for Telegram, X, Facebook, Instagram, and
// LinkedIn. Each platform still depends on valid OAuth scopes, account
// metadata, and platform-side permissions; missing prerequisites return an
// explicit error and never mark the job as successful.
// ---------------------------------------------------------------------------

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } }
);

const META_GRAPH_VERSION = Deno.env.get('META_GRAPH_VERSION') ?? 'v26.0';
const LINKEDIN_API_VERSION = Deno.env.get('LINKEDIN_API_VERSION') ?? '202607';
const LINKEDIN_RESTLI_PROTOCOL_VERSION = '2.0.0';

function jsonRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

function apiErrorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') return fallback;
  const record = body as Record<string, unknown>;
  if (typeof record.message === 'string' && record.message.trim()) return record.message;
  if (typeof record.detail === 'string' && record.detail.trim()) return record.detail;
  if (typeof record.title === 'string' && record.title.trim()) return record.title;
  if (typeof record.error_description === 'string' && record.error_description.trim()) return record.error_description;
  if (typeof record.description === 'string' && record.description.trim()) return record.description;
  if (typeof record.error === 'string' && record.error.trim()) return record.error;
  if (record.error && typeof record.error === 'object' && typeof (record.error as Record<string, unknown>).message === 'string') {
    return String((record.error as Record<string, unknown>).message);
  }
  if (Array.isArray(record.errors) && record.errors[0] && typeof record.errors[0] === 'object' && typeof (record.errors[0] as Record<string, unknown>).message === 'string') {
    return String((record.errors[0] as Record<string, unknown>).message);
  }
  return fallback;
}

const PLATFORM_LABELS: Record<string, string> = {
  facebook: 'فيسبوك',
  instagram: 'إنستجرام',
  linkedin: 'لينكدإن',
  x: 'إكس',
  threads: 'ثريدز',
  tiktok: 'تيك توك',
  telegram: 'تيليجرام',
  whatsapp: 'واتساب',
};

const SUPPORTED_PLATFORMS = new Set(['telegram', 'x', 'facebook', 'instagram', 'linkedin', 'threads']);

type Variant = {
  id: string;
  content_id: string;
  workspace_id: string;
  platform: string;
  text: string;
  hashtags: string[];
  cta: string | null;
  media_brief: Record<string, unknown>;
  media_id?: string | null;
};

function buildPostText(variant: Variant, maxLen?: number): string {
  const parts = [variant.text.trim()];
  if (variant.cta && variant.cta.trim()) parts.push(variant.cta.trim());
  if (variant.hashtags?.length) parts.push(variant.hashtags.join(' '));
  let text = parts.filter(Boolean).join('\n\n');
  if (maxLen && text.length > maxLen) text = text.slice(0, maxLen - 1) + '…';
  return text;
}

// ---------------------------------------------------------------------------
// Media resolution. The UI/Agent attach media through content_variants.media_id
// (media table + public `media` bucket, migration 0033). Publishing used to
// read only media_brief.image_url, which nothing ever sets, so attached media
// was never published and Instagram always failed. media_brief.image_url is
// kept as a legacy fallback. This block is intentionally identical in
// social-publish and scheduler-tick (no cross-function imports in this
// deployment model) — change both together.
// ---------------------------------------------------------------------------
type ResolvedMedia = { url: string; kind: 'image' | 'video'; mime: string | null } | null;

async function resolveVariantMedia(variant: Variant): Promise<ResolvedMedia> {
  if (variant.media_id) {
    const { data: media } = await supabase
      .from('media')
      .select('storage_path, kind, mime_type')
      .eq('id', variant.media_id)
      .eq('workspace_id', variant.workspace_id)
      .maybeSingle();
    if (!media) throw new Error('الميديا المرفقة بالنسخة مش موجودة — أعد إرفاقها أو أزلها قبل النشر');
    const { data } = supabase.storage.from('media').getPublicUrl(String(media.storage_path));
    return { url: data.publicUrl, kind: media.kind === 'video' ? 'video' : 'image', mime: typeof media.mime_type === 'string' ? media.mime_type : null };
  }
  const legacy = variant.media_brief?.image_url;
  return typeof legacy === 'string' && legacy ? { url: legacy, kind: 'image', mime: null } : null;
}

function assertImageOnly(media: ResolvedMedia, platformLabel: string): void {
  if (media?.kind === 'video') throw new Error(`نشر الفيديو على ${platformLabel} غير مدعوم بعد — أزل الفيديو أو انشر يدويًا`);
}

function assertNoMedia(media: ResolvedMedia, platformLabel: string): void {
  if (media) throw new Error(`رفع الصور/الفيديو على ${platformLabel} غير مدعوم بعد — أزل الميديا من النسخة أو انشر يدويًا (لن يُنشر النص بدون الصورة المرفقة)`);
}

async function fetchWithRetry(input: string | URL, init: RequestInit = {}, maxAttempts = 3): Promise<Response> {
  let response: Response | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    response = await fetch(input, init);
    const retryable = response.status === 429 || response.status >= 500;
    if (response.ok || !retryable || attempt === maxAttempts) return response;
    const retryAfter = Number(response.headers.get('retry-after') ?? 0);
    const waitMs = Math.min(5_000, retryAfter > 0 ? retryAfter * 1_000 : 250 * (2 ** (attempt - 1)));
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  return response as Response;
}

// ---------------------------------------------------------------------------
// Telegram — bot posts into the channel the workspace connected. Uses
// sendPhoto when the variant has an image in media_brief, sendMessage
// otherwise. Bot token lives in social_platform_app_secrets (shared bot).
// ---------------------------------------------------------------------------
async function publishToTelegram(variant: Variant, account: Record<string, unknown>, media: ResolvedMedia): Promise<{ id: string; url: string | null }> {
  const { data: secretRow } = await supabase
    .from('social_platform_app_secrets')
    .select('app_secret')
    .eq('platform_key', 'telegram')
    .maybeSingle();
  const botToken = secretRow?.app_secret;
  if (!botToken) throw new Error('بوت تيليجرام لسه مش مُعد من إدارة النظام');

  const metadata = (account.metadata ?? {}) as Record<string, unknown>;
  const chatId = metadata.chat_id ?? account.handle;
  if (!chatId) throw new Error('تعذّر تحديد قناة تيليجرام المربوطة');

  const text = buildPostText(variant, 4096);
  const method = media ? (media.kind === 'video' ? 'sendVideo' : 'sendPhoto') : 'sendMessage';
  const params: Record<string, string> = media
    ? { chat_id: String(chatId), [media.kind === 'video' ? 'video' : 'photo']: media.url, caption: text.slice(0, 1024) }
    : { chat_id: String(chatId), text };

  const res = await fetchWithRetry(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(apiErrorMessage(json, 'فشل النشر على تيليجرام'));

  const messageId = json.result?.message_id;
  const chatUsername = typeof account.handle === 'string' ? String(account.handle).replace(/^@/, '') : null;
  const url = chatUsername && messageId ? `https://t.me/${chatUsername}/${messageId}` : null;
  return { id: String(messageId ?? ''), url };
}

// ---------------------------------------------------------------------------
// X (Twitter) — posts as the connected member via API v2 POST /2/tweets.
// Refreshes the access token first if it's expired (offline.access scope
// was requested at connect time, so a refresh_token should be on file).
// ---------------------------------------------------------------------------
async function getFreshXToken(accountId: string): Promise<string> {
  const { data: tokenRow } = await supabase
    .from('social_account_tokens')
    .select('access_token, refresh_token, expires_at')
    .eq('account_id', accountId)
    .maybeSingle();
  if (!tokenRow?.access_token) throw new Error('حساب إكس محتاج إعادة ربط');

  const isExpired = tokenRow.expires_at ? new Date(tokenRow.expires_at).getTime() < Date.now() + 60_000 : false;
  if (!isExpired) return tokenRow.access_token as string;
  if (!tokenRow.refresh_token) throw new Error('انتهت صلاحية دخول إكس — أعد ربط الحساب');

  const { data: app } = await supabase.from('social_platform_apps').select('app_id').eq('platform_key', 'x').maybeSingle();
  const { data: secretRow } = await supabase.from('social_platform_app_secrets').select('app_secret').eq('platform_key', 'x').maybeSingle();
  if (!app?.app_id || !secretRow?.app_secret) throw new Error('إعدادات ربط إكس غير مكتملة');

  const res = await fetchWithRetry('https://api.twitter.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${btoa(`${app.app_id}:${secretRow.app_secret}`)}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokenRow.refresh_token as string,
      client_id: app.app_id,
    }),
  });
  const json = await res.json();
  if (!res.ok || !json.access_token) throw new Error(json?.error_description ?? 'فشل تجديد دخول إكس');

  const expiresAt = json.expires_in ? new Date(Date.now() + json.expires_in * 1000).toISOString() : null;
  await supabase.from('social_account_tokens').update({
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? tokenRow.refresh_token,
    expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  }).eq('account_id', accountId);

  return json.access_token as string;
}

async function getFreshThreadsToken(accountId: string): Promise<string> {
  const { data: token } = await supabase
    .from('social_account_tokens')
    .select('access_token,expires_at')
    .eq('account_id', accountId)
    .maybeSingle();
  if (!token?.access_token) throw new Error('حساب Threads محتاج إعادة ربط');

  const expiresAt = token.expires_at ? new Date(token.expires_at).getTime() : null;
  if (!expiresAt || expiresAt > Date.now() + 7 * 24 * 60 * 60 * 1000) return String(token.access_token);
  if (expiresAt <= Date.now()) {
    await supabase.from('social_accounts').update({ status: 'expired', needs_reconnect: true }).eq('id', accountId);
    throw new Error('انتهت صلاحية Threads — أعد ربط الحساب');
  }

  const url = new URL('https://graph.threads.net/refresh_access_token');
  url.searchParams.set('grant_type', 'th_refresh_token');
  url.searchParams.set('access_token', String(token.access_token));
  const response = await fetchWithRetry(url);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new Error(apiErrorMessage(body, 'فشل تجديد دخول Threads'));
  }
  const nextExpiresAt = typeof body.expires_in === 'number'
    ? new Date(Date.now() + body.expires_in * 1000).toISOString()
    : token.expires_at;
  await supabase.from('social_account_tokens').update({
    access_token: body.access_token,
    expires_at: nextExpiresAt,
    updated_at: new Date().toISOString(),
  }).eq('account_id', accountId);
  return String(body.access_token);
}

async function getStoredAccessToken(accountId: string): Promise<string> {
  const { data: token } = await supabase.from('social_account_tokens').select('access_token,expires_at').eq('account_id', accountId).maybeSingle();
  if (!token?.access_token) throw new Error('الحساب محتاج إعادة ربط');
  if (token.expires_at && new Date(token.expires_at).getTime() < Date.now() + 60_000) {
    await supabase.from('social_accounts').update({ status: 'expired', needs_reconnect: true }).eq('id', accountId);
    throw new Error('انتهت صلاحية التوكن — أعد ربط الحساب');
  }
  return String(token.access_token);
}

async function publishToFacebook(variant: Variant, account: Record<string, unknown>, media: ResolvedMedia): Promise<{ id: string; url: string | null }> {
  const accessToken = await getStoredAccessToken(String(account.id));
  const pageId = String(account.page_id ?? account.external_id ?? account.handle ?? '');
  if (!pageId) throw new Error('لم يتم العثور على Page ID لفيسبوك');
  assertImageOnly(media, 'فيسبوك');
  // With an image the Page photo endpoint is used (it creates the feed post);
  // it answers with post_id (the feed post) alongside id (the photo).
  const endpoint = media ? 'photos' : 'feed';
  const payload = media
    ? { url: media.url, caption: buildPostText(variant), access_token: accessToken }
    : { message: buildPostText(variant), access_token: accessToken };
  const response = await fetchWithRetry(`https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(pageId)}/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const body = await response.json();
  const postId = body.post_id ?? body.id;
  if (!response.ok || !postId) throw new Error(apiErrorMessage(body, 'فشل النشر على فيسبوك'));
  return { id: String(postId), url: `https://www.facebook.com/${postId}` };
}

async function publishToInstagram(variant: Variant, account: Record<string, unknown>, media: ResolvedMedia): Promise<{ id: string; url: string | null }> {
  const accessToken = await getStoredAccessToken(String(account.id));
  const igId = String(account.ig_user_id ?? account.external_id ?? '');
  assertImageOnly(media, 'إنستجرام');
  const imageUrl = media?.url ?? '';
  if (!igId) throw new Error('لم يتم العثور على Instagram Business Account لهذا الحساب — أعد ربط الحساب');
  if (!imageUrl) throw new Error('إنستجرام يحتاج صورة — أرفق صورة بالنسخة قبل النشر');
  // Instagram Content Publishing accepts JPEG only; the UI also lets users attach PNG/WEBP/GIF.
  if (media?.mime && media.mime !== 'image/jpeg') throw new Error('إنستجرام يقبل صور JPEG فقط — بدّل الصورة المرفقة بصيغة JPG قبل النشر');
  const createResponse = await fetchWithRetry(`https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(igId)}/media`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image_url: imageUrl, caption: buildPostText(variant), access_token: accessToken }) });
  const createBody = await createResponse.json();
  if (!createResponse.ok || !createBody.id) throw new Error(apiErrorMessage(createBody, 'فشل إنشاء منشور إنستجرام'));
  const publishResponse = await fetchWithRetry(`https://graph.facebook.com/${META_GRAPH_VERSION}/${encodeURIComponent(igId)}/media_publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ creation_id: createBody.id, access_token: accessToken }) });
  const publishBody = await publishResponse.json();
  if (!publishResponse.ok || !publishBody.id) throw new Error(apiErrorMessage(publishBody, 'فشل نشر منشور إنستجرام'));
  return { id: String(publishBody.id), url: null };
}

async function publishToThreads(variant: Variant, account: Record<string, unknown>, media: ResolvedMedia): Promise<{ id: string; url: string | null }> {
  if (media?.kind === 'video') {
    throw new Error('فيديو Threads يحتاج انتظار معالجة الـcontainer — استخدم نص أو صورة في الجدولة الحالية');
  }
  const accessToken = await getFreshThreadsToken(String(account.id));
  const createUrl = new URL('https://graph.threads.net/v1.0/me/threads');
  createUrl.searchParams.set('access_token', accessToken);
  createUrl.searchParams.set('text', buildPostText(variant, 500));
  if (media?.kind === 'image') {
    createUrl.searchParams.set('media_type', 'IMAGE');
    createUrl.searchParams.set('image_url', media.url);
  } else {
    createUrl.searchParams.set('media_type', 'TEXT');
  }

  const createResponse = await fetchWithRetry(createUrl, { method: 'POST' });
  const createBody = await createResponse.json().catch(() => ({}));
  if (!createResponse.ok || !createBody.id) {
    throw new Error(apiErrorMessage(createBody, 'فشل إنشاء منشور Threads'));
  }

  const publishUrl = new URL('https://graph.threads.net/v1.0/me/threads_publish');
  publishUrl.searchParams.set('access_token', accessToken);
  publishUrl.searchParams.set('creation_id', String(createBody.id));
  const publishResponse = await fetchWithRetry(publishUrl, { method: 'POST' });
  const publishBody = await publishResponse.json().catch(() => ({}));
  if (!publishResponse.ok || !publishBody.id) {
    throw new Error(apiErrorMessage(publishBody, 'فشل نشر منشور Threads'));
  }
  return { id: String(publishBody.id), url: null };
}

async function publishToLinkedIn(variant: Variant, account: Record<string, unknown>, media: ResolvedMedia): Promise<{ id: string; url: string | null }> {
  assertNoMedia(media, 'لينكدإن');
  const accessToken = await getStoredAccessToken(String(account.id));
  const author = String((account.metadata as Record<string, unknown> | undefined)?.urn ?? `urn:li:person:${account.external_id ?? ''}`);
  if (!author || author.endsWith(':')) throw new Error('لم يتم العثور على هوية LinkedIn');
  const response = await fetchWithRetry('https://api.linkedin.com/rest/posts', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Restli-Protocol-Version': LINKEDIN_RESTLI_PROTOCOL_VERSION,
      'Linkedin-Version': LINKEDIN_API_VERSION,
    },
    body: JSON.stringify({
      author,
      commentary: buildPostText(variant, 3000),
      visibility: 'PUBLIC',
      distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
      lifecycleState: 'PUBLISHED',
      isReshareDisabledByAuthor: false,
    }),
  });
  const body = await response.json().catch(() => ({}));
  const postId = response.headers.get('x-restli-id') ?? (body as Record<string, unknown>).id;
  if (!response.ok || !postId) throw new Error(apiErrorMessage(body, 'فشل النشر على لينكدإن؛ تحقق من صلاحية w_member_social وإعادة ربط الحساب'));
  return { id: String(postId), url: null };
}

async function publishToX(variant: Variant, account: Record<string, unknown>, media: ResolvedMedia): Promise<{ id: string; url: string | null }> {
  assertNoMedia(media, 'إكس');
  const accessToken = await getFreshXToken(String(account.id));
  const text = buildPostText(variant, 280);

  const res = await fetchWithRetry('https://api.twitter.com/2/tweets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ text }),
  });
  const json = await res.json();
  if (!res.ok || !json.data?.id) {
    const message = apiErrorMessage(json, 'فشل النشر على إكس');
    throw new Error(message);
  }

  const handle = typeof account.handle === 'string' ? String(account.handle).replace(/^@/, '') : null;
  const url = handle ? `https://x.com/${handle}/status/${json.data.id}` : null;
  return { id: String(json.data.id), url };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'POST') return jsonRes(405, { error: 'Method not allowed' });

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return jsonRes(401, { error: 'Missing authentication token' });
  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  let userId = userData.user?.id;
  let taskWorkspace: string | null = null;
  if (token === serviceRoleKey && serviceRoleKey) {
    const { data: task } = await supabase.from('assistant_tasks').select('user_id, workspace_id, task_kind, payload, locked_at')
      .eq('id', req.headers.get('X-Assistant-Task') ?? '').eq('worker_id', req.headers.get('X-Assistant-Worker') ?? '').eq('status', 'running').maybeSingle();
    if (!task || Date.now() - new Date(task.locked_at).getTime() >= 10 * 60_000 || !['publish','approved'].includes(task.task_kind)) return jsonRes(403, { error: 'Invalid task lease' });
    userId = task.user_id;
    taskWorkspace = task.workspace_id;
  } else if (userError || !userId) return jsonRes(401, { error: 'Invalid or expired token' });

  let body: { workspaceId?: string; variantId?: string; calendarItemId?: string };
  try {
    body = await req.json();
  } catch {
    return jsonRes(400, { error: 'Invalid JSON body' });
  }

  const { workspaceId, variantId, calendarItemId } = body;
  if (taskWorkspace && taskWorkspace !== workspaceId) return jsonRes(403, { error: 'Task workspace mismatch' });
  if (!workspaceId || !variantId) return jsonRes(400, { error: 'workspaceId و variantId مطلوبين' });

  const { data: membership } = await supabase
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();
  if (!membership) return jsonRes(403, { error: 'مش عضو في مساحة العمل دي' });

  const { data: variant } = await supabase
    .from('content_variants')
    .select('*')
    .eq('id', variantId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (!variant) return jsonRes(404, { error: 'النسخة غير موجودة' });

  // Same rule approve_content_variant enforces: Publish Now must not be a
  // way around the quality review, and rejected variants never go out.
  if (variant.status === 'rejected') {
    return jsonRes(409, { error: 'النسخة دي مرفوضة — مينفعش تتنشر.' });
  }
  if (variant.quality_status === 'needs_improvement' || variant.quality_status === 'failed') {
    return jsonRes(409, { error: 'مراجعة الجودة لسه مطلوبة — حسّن النسخة قبل النشر.' });
  }

  const platform = variant.platform as string;
  const platformLabel = PLATFORM_LABELS[platform] ?? platform;

  if (!SUPPORTED_PLATFORMS.has(platform)) {
    return jsonRes(409, { error: `النشر التلقائي على ${platformLabel} غير مدعوم بعد — تقدر تنسخ النص وتنشره يدويًا` });
  }

  const { data: account } = await supabase
    .from('social_accounts')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('platform', platform)
    .eq('status', 'connected')
    .maybeSingle();
  if (!account) return jsonRes(409, { error: `مفيش حساب ${platformLabel} مربوط بهذه المساحة` });

  const idempotencyKey = calendarItemId ? `cal:${calendarItemId}` : `manual:${variantId}`;

  let { data: existingJob } = await supabase
    .from('publishing_jobs')
    .select('*')
    .eq('idempotency_key', idempotencyKey)
    .maybeSingle();

  // Scheduled jobs use a stable workspace/variant/time key. Reuse that row
  // when a user clicks Publish Now for the same calendar item; otherwise the
  // manual path and scheduler could publish the same variant twice.
  if (!existingJob && calendarItemId) {
    const { data: scheduledJob } = await supabase
      .from('publishing_jobs')
      .select('*')
      .eq('workspace_id', workspaceId)
      .eq('variant_id', variantId)
      .eq('calendar_item_id', calendarItemId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    existingJob = scheduledJob;
  }

  if (existingJob?.status === 'succeeded') {
    return jsonRes(200, { ok: true, alreadyPublished: true, job: existingJob });
  }
  if (existingJob && Number(existingJob.attempts ?? 0) >= Number(existingJob.max_attempts ?? 3)) {
    return jsonRes(409, { error: 'تم الوصول إلى الحد الأقصى لمحاولات النشر؛ أعد ربط الحساب أو أنشئ محاولة جديدة.', job: existingJob });
  }
  if (existingJob?.status === 'running') {
    return jsonRes(409, { error: 'توجد محاولة نشر جارية لنفس المحتوى؛ أعد المحاولة بعد لحظات.', job: existingJob });
  }

  let job = existingJob;
  if (job) {
    const { data: updated, error: updateError } = await supabase
      .from('publishing_jobs')
      .update({
        action: 'publish',
        status: 'running',
        attempts: Number(job.attempts ?? 0) + 1,
        last_error: null,
        last_attempt_at: new Date().toISOString(),
        platform,
      })
      .eq('id', job.id)
      .in('status', ['queued', 'failed'])
      .select()
      .maybeSingle();
    if (updateError || !updated) {
      return jsonRes(409, { error: 'توجد محاولة نشر جارية لنفس المحتوى؛ أعد المحاولة بعد لحظات.', job });
    }
    job = updated;
  } else {
    const { data: inserted, error: insertError } = await supabase
      .from('publishing_jobs')
      .insert({
        workspace_id: workspaceId,
        variant_id: variantId,
        calendar_item_id: calendarItemId ?? null,
        idempotency_key: idempotencyKey,
        action: 'publish',
        status: 'running',
        attempts: 1,
        max_attempts: 3,
        last_attempt_at: new Date().toISOString(),
        platform,
      })
      .select()
      .maybeSingle();
    if (insertError || !inserted) {
      if (insertError?.code === '23505') {
        const { data: racedJob } = await supabase
          .from('publishing_jobs')
          .select('*')
          .eq('workspace_id', workspaceId)
          .eq('variant_id', variantId)
          .eq('calendar_item_id', calendarItemId)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (racedJob?.status === 'succeeded') return jsonRes(200, { ok: true, alreadyPublished: true, job: racedJob });
        if (racedJob) return jsonRes(409, { error: 'توجد محاولة نشر جارية لنفس المحتوى؛ أعد المحاولة بعد لحظات.', job: racedJob });
      }
      return jsonRes(500, { error: insertError?.message ?? 'تعذّر إنشاء مهمة النشر' });
    }
    job = inserted;
  }

  if (calendarItemId) {
    await supabase.from('calendar_items').update({ status: 'publishing' }).eq('id', calendarItemId);
  }

  try {
    const media = await resolveVariantMedia(variant as Variant);
    const result = platform === 'telegram'
      ? await publishToTelegram(variant as Variant, account, media)
      : platform === 'x'
        ? await publishToX(variant as Variant, account, media)
        : platform === 'facebook'
          ? await publishToFacebook(variant as Variant, account, media)
          : platform === 'instagram'
            ? await publishToInstagram(variant as Variant, account, media)
            : platform === 'threads'
              ? await publishToThreads(variant as Variant, account, media)
              : await publishToLinkedIn(variant as Variant, account, media);

    const publishedAt = new Date().toISOString();
    const publishState = {
      status: 'succeeded',
      completed_at: publishedAt,
      published_at: publishedAt,
      last_attempt_at: publishedAt,
      external_post_id: result.id,
      platform,
      last_error: null,
    };
    const { error: publishStateError } = await supabase.from('publishing_jobs').update({
      ...publishState,
      result: { platform, post_id: result.id, url: result.url },
    }).eq('id', job.id);
    if (publishStateError) {
      const { error: fallbackStateError } = await supabase.from('publishing_jobs').update(publishState).eq('id', job.id);
      if (fallbackStateError) throw new Error(`تمت استجابة المنصة لكن تعذر حفظ حالة النشر: ${fallbackStateError.message}`);
    }

    if (calendarItemId) {
      await supabase.from('calendar_items').update({ status: 'published' }).eq('id', calendarItemId);
    }
    // Best-effort: mark the parent content as published once at least one
    // of its variants has actually gone out.
    await supabase.from('content').update({ status: 'published' }).eq('id', variant.content_id);

    await supabase.from('notifications').insert({
      workspace_id: workspaceId,
      user_id: userId,
      type: 'publish_succeeded',
      title: `تم النشر على ${platformLabel}`,
      body: result.url ?? null,
      payload: { variant_id: variantId, platform, post_id: result.id, url: result.url },
    });
    await supabase.from('audit_logs').insert({
      workspace_id: workspaceId,
      user_id: userId,
      action: 'publish_succeeded',
      entity: 'content_variants',
      entity_id: variantId,
      detail: { platform, post_id: result.id },
    });

    return jsonRes(200, { ok: true, postId: result.id, url: result.url, job: { ...job, status: 'succeeded' } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'فشل النشر';

    await supabase.from('publishing_jobs').update({
      status: 'failed',
      last_attempt_at: new Date().toISOString(),
      last_error: message,
    }).eq('id', job.id);

    if (calendarItemId) {
      await supabase.from('calendar_items').update({ status: 'failed' }).eq('id', calendarItemId);
    }

    await supabase.from('notifications').insert({
      workspace_id: workspaceId,
      user_id: userId,
      type: 'publish_failed',
      title: `فشل النشر على ${platformLabel}`,
      body: message,
      payload: { variant_id: variantId, platform },
    });
    await supabase.from('audit_logs').insert({
      workspace_id: workspaceId,
      user_id: userId,
      action: 'publish_failed',
      entity: 'content_variants',
      entity_id: variantId,
      detail: { platform, error: message },
    });

    return jsonRes(502, { error: message });
  }
});
