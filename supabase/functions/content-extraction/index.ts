import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import * as cheerio from 'npm:cheerio@1.0.0';
import Parser from 'npm:rss-parser@3.13.0';
import { YoutubeTranscript } from 'npm:youtube-transcript@1.2.1';
// deno-lint-ignore no-explicit-any
import pdfParse from 'npm:pdf-parse@1.1.1';
import mammoth from 'npm:mammoth@1.8.0';
import * as XLSX from 'npm:xlsx@0.18.5';

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('APP_URL')?.replace(/\/$/, '') || '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const FETCH_TIMEOUT_MS = 20_000;
const MAX_ITEMS_PER_SOURCE = 5;
const MAX_CHARS_PER_ITEM = 8_000;

type SourceType = 'rss' | 'url' | 'pdf' | 'word' | 'excel' | 'youtube';

type ContentSourceRow = {
  id: string;
  workspace_id: string;
  type: SourceType;
  name: string | null;
  source_url: string | null;
  file_path: string | null;
  last_fetched_at: string | null;
  last_processed_hash: string | null;
};

type ProposedItem = {
  source_id: string;
  source_name: string | null;
  source_type: SourceType;
  title: string;
  url: string | null;
  content_hash: string;
  summary: string;
  relevant: boolean;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}
function errorResponse(message: string, status = 500): Response {
  return jsonResponse({ error: message }, status);
}

async function isWorkspaceMember(supabase: SupabaseClient, workspaceId: string, userId: string): Promise<boolean> {
  const { data } = await supabase.from('workspace_members').select('id').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle();
  return !!data;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal, headers: { 'User-Agent': 'SocialPilotAI-ContentSources/1.0', ...init.headers } });
  } finally {
    clearTimeout(timer);
  }
}

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function truncate(text: string, max = MAX_CHARS_PER_ITEM): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? clean.slice(0, max) + '…' : clean;
}

type RawItem = { title: string; url: string | null; text: string; publishedAt?: string };

// ---------------------------------------------------------------------------
// Per-type extraction. Each returns raw text items — nothing here is
// persisted; it only ever lives in memory for the duration of this request.
// ---------------------------------------------------------------------------

async function extractRss(source: ContentSourceRow): Promise<RawItem[]> {
  if (!source.source_url) throw new Error('لا يوجد رابط RSS لهذا المصدر');
  const parser = new Parser({ timeout: FETCH_TIMEOUT_MS });
  const feed = await parser.parseURL(source.source_url);
  const since = source.last_fetched_at ? new Date(source.last_fetched_at).getTime() : 0;
  const items = (feed.items ?? [])
    .filter((item) => {
      if (!since) return true;
      const pubDate = item.isoDate || item.pubDate;
      return !pubDate || new Date(pubDate).getTime() > since;
    })
    .slice(0, MAX_ITEMS_PER_SOURCE);

  return items.map((item) => ({
    title: item.title || 'بدون عنوان',
    url: item.link || null,
    text: truncate(item.contentSnippet || item.content || item.summary || item.title || ''),
    publishedAt: item.isoDate || item.pubDate,
  }));
}

async function extractUrl(source: ContentSourceRow): Promise<RawItem[]> {
  if (!source.source_url) throw new Error('لا يوجد رابط لهذا المصدر');
  const res = await fetchWithTimeout(source.source_url);
  if (!res.ok) throw new Error(`فشل جلب الصفحة: ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  $('script, style, nav, footer, header, noscript, iframe').remove();
  const title = $('title').first().text() || $('h1').first().text() || source.source_url;
  const bodyText =
    $('article').text() ||
    $('main').text() ||
    $('body').text();
  return [{ title: truncate(title, 200), url: source.source_url, text: truncate(bodyText) }];
}

async function extractYoutube(source: ContentSourceRow): Promise<RawItem[]> {
  if (!source.source_url) throw new Error('لا يوجد رابط يوتيوب لهذا المصدر');
  const videoIdMatch = source.source_url.match(/(?:v=|youtu\.be\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  const videoId = videoIdMatch?.[1];
  if (!videoId) throw new Error('تعذر استخراج معرّف الفيديو من الرابط');

  let transcriptText = '';
  try {
    const transcript = await YoutubeTranscript.fetchTranscript(videoId);
    transcriptText = transcript.map((t: { text: string }) => t.text).join(' ');
  } catch {
    // Transcript unavailable (disabled captions, private video, etc) — fall
    // back to whatever we can read from the video page below.
  }

  let title = source.source_url;
  const description = '';
  try {
    const res = await fetchWithTimeout(`https://www.youtube.com/oembed?url=${encodeURIComponent(source.source_url)}&format=json`);
    if (res.ok) {
      const oembed = await res.json();
      title = oembed.title || title;
    }
  } catch {
    // oEmbed is best-effort metadata only
  }

  const combined = transcriptText || description;
  if (!combined) throw new Error('لا يوجد نص أو وصف متاح لهذا الفيديو');

  return [{ title: truncate(title, 200), url: source.source_url, text: truncate(combined) }];
}

async function downloadSourceFile(supabase: SupabaseClient, source: ContentSourceRow): Promise<ArrayBuffer> {
  if (!source.file_path) throw new Error('لا يوجد ملف مرفوع لهذا المصدر');
  const { data, error } = await supabase.storage.from('content-sources').download(source.file_path);
  if (error || !data) throw new Error(`فشل تنزيل الملف: ${error?.message ?? 'unknown error'}`);
  return await data.arrayBuffer();
}

async function extractPdf(supabase: SupabaseClient, source: ContentSourceRow): Promise<RawItem[]> {
  const buffer = await downloadSourceFile(supabase, source);
  const parsed = await pdfParse(new Uint8Array(buffer));
  return [{ title: source.name || 'مستند PDF', url: null, text: truncate(parsed.text) }];
}

async function extractWord(supabase: SupabaseClient, source: ContentSourceRow): Promise<RawItem[]> {
  const buffer = await downloadSourceFile(supabase, source);
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  return [{ title: source.name || 'مستند Word', url: null, text: truncate(result.value) }];
}

async function extractExcel(supabase: SupabaseClient, source: ContentSourceRow): Promise<RawItem[]> {
  const buffer = await downloadSourceFile(supabase, source);
  const workbook = XLSX.read(new Uint8Array(buffer), { type: 'array' });
  const parts: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
    parts.push(`# ${sheetName}\n${csv}`);
  }
  return [{ title: source.name || 'ملف Excel', url: null, text: truncate(parts.join('\n\n')) }];
}

async function extractForSource(supabase: SupabaseClient, source: ContentSourceRow): Promise<RawItem[]> {
  switch (source.type) {
    case 'rss': return await extractRss(source);
    case 'url': return await extractUrl(source);
    case 'youtube': return await extractYoutube(source);
    case 'pdf': return await extractPdf(supabase, source);
    case 'word': return await extractWord(supabase, source);
    case 'excel': return await extractExcel(supabase, source);
    default: throw new Error(`نوع مصدر غير مدعوم: ${source.type}`);
  }
}

// ---------------------------------------------------------------------------
// Brand-voice filtering + summarization — delegated to the ai-gateway edge
// function (same provider chain, keys, and fallback logic already built
// there) instead of duplicating provider-calling code here.
// ---------------------------------------------------------------------------

async function filterAndSummarize(
  supabaseUrl: string,
  authHeader: string,
  workspaceId: string,
  brandVoice: Record<string, unknown> | null,
  item: RawItem,
  backgroundJobId?: string,
): Promise<{ relevant: boolean; summary: string }> {
  // "Understand & Summarize" stage of the pipeline: Extract Source →
  // Understand & Summarize → Rewrite in Professional Egyptian Arabic →
  // Content Quality Check → Final Content. This summary is intermediate
  // grounding material ONLY — it is shown as a preview card and later passed
  // as context to the Creator agent, but it is never itself scheduled or
  // published as a post. It deliberately does not attempt Egyptian Arabic
  // phrasing here; that rewrite happens as its own dedicated step downstream
  // (see EGYPTIAN_ARABIC_WRITING_RULES in assistantOrchestrator.ts) so the
  // two concerns — factual summarization vs. dialect/voice — stay separate.
  const prompt =
    `Below is raw content pulled from a content source (RSS/Web/YouTube/PDF/Word/Excel). Decide if it fits ` +
    `this workspace's brand/niche, and produce a short, neutral, factual summary (2-4 sentences) suitable for ` +
    `a content-idea preview card. This is NOT final, publish-ready content — do not write it as a finished ` +
    `social media post, do not add hooks/hashtags/CTAs, and do not copy sentences verbatim from the source. ` +
    `Just capture the key facts/ideas plainly; a later step will rewrite this into a proper post.\n\n` +
    `Title: ${item.title}\n\nContent:\n${item.text}\n\n` +
    `Respond ONLY with minified JSON, no markdown, in exactly this shape: ` +
    `{"relevant": boolean, "summary": "string"}`;

  const res = await fetchWithTimeout(
    `${supabaseUrl}/functions/v1/ai-gateway?action=chat`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: authHeader,
        ...(backgroundJobId ? { 'X-Content-Generation-Job': backgroundJobId } : {}),
      },
      body: JSON.stringify({
        workspace_id: workspaceId,
        ...(backgroundJobId ? { background_job_id: backgroundJobId } : {}),
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        brand_voice: brandVoice,
      }),
    },
    30_000,
  );

  if (!res.ok) {
    // AI couldn't score this item (no provider configured, etc) — surface it
    // as relevant-by-default with a plain-text fallback summary rather than
    // dropping it silently.
    return { relevant: true, summary: truncate(item.text, 280) };
  }

  const data = await res.json();
  const raw: string = data.content ?? '';
  try {
    const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/```$/, '');
    const parsed = JSON.parse(cleaned);
    return { relevant: !!parsed.relevant, summary: String(parsed.summary || '').slice(0, 1000) || truncate(item.text, 280) };
  } catch {
    return { relevant: true, summary: truncate(raw || item.text, 280) };
  }
}

async function handleFetch(
  supabase: SupabaseClient,
  supabaseUrl: string,
  authHeader: string,
  workspaceId: string,
  sourceIds: string[] | undefined,
  backgroundJobId?: string,
): Promise<Response> {
  let query = supabase.from('content_sources').select('*').eq('workspace_id', workspaceId);
  if (sourceIds && sourceIds.length > 0) query = query.in('id', sourceIds);
  const { data: sources, error } = await query;
  if (error) return errorResponse(error.message, 500);
  if (!sources || sources.length === 0) return jsonResponse({ items: [], errors: [] });

  const { data: brandVoiceRow } = await supabase.from('brand_voice').select('*').eq('workspace_id', workspaceId).maybeSingle();

  const proposed: ProposedItem[] = [];
  const failures: { source_id: string; error: string }[] = [];

  for (const source of sources as ContentSourceRow[]) {
    await supabase.from('content_sources').update({ status: 'fetching', last_error: null }).eq('id', source.id);
    try {
      const rawItems = await extractForSource(supabase, source);
      let allDuplicates = rawItems.length > 0;

      for (const item of rawItems) {
        const contentHash = await sha256(`${source.id}:${item.title}:${item.text}`);
        if (source.last_processed_hash && source.last_processed_hash === contentHash) {
          continue; // already processed this exact content — skip per the no-reprocessing rule
        }
        allDuplicates = false;

        const { relevant, summary } = await filterAndSummarize(supabaseUrl, authHeader, workspaceId, brandVoiceRow, item, backgroundJobId);
        if (!relevant) continue;

        proposed.push({
          source_id: source.id,
          source_name: source.name,
          source_type: source.type,
          title: item.title,
          url: item.url,
          content_hash: contentHash,
          summary,
          relevant,
        });
      }

      await supabase
        .from('content_sources')
        .update({
          status: 'ready',
          last_fetched_at: new Date().toISOString(),
          last_error: allDuplicates ? null : null,
        })
        .eq('id', source.id);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'خطأ غير معروف أثناء الجلب';
      failures.push({ source_id: source.id, error: message });
      await supabase.from('content_sources').update({ status: 'error', last_error: message }).eq('id', source.id);
    }
  }

  return jsonResponse({ items: proposed, errors: failures });
}

// Marks a source's `last_processed_hash` once its content has been turned
// into scheduled posts — called by the frontend right after a successful
// AI generation + posts insert, so this exact content is not re-suggested.
async function handleMarkProcessed(supabase: SupabaseClient, workspaceId: string, sourceId: string, contentHash: string): Promise<Response> {
  const { data: source, error: fetchError } = await supabase.from('content_sources').select('id, workspace_id').eq('id', sourceId).maybeSingle();
  if (fetchError || !source || source.workspace_id !== workspaceId) return errorResponse('Source not found', 404);
  const { error } = await supabase.from('content_sources').update({ last_processed_hash: contentHash }).eq('id', sourceId);
  if (error) return errorResponse(error.message, 500);
  return jsonResponse({ ok: true });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey, { auth: { autoRefreshToken: false, persistSession: false } });

    const authHeader = req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) return errorResponse('Unauthorized: no Authorization header sent', 401);
    const body = await req.json().catch(() => ({})) as { workspace_id?: string; source_ids?: string[]; source_id?: string; content_hash?: string; background_job_id?: string };
    const backgroundJobId = req.headers.get('X-Content-Generation-Job');
    let callerId: string;
    let isBackgroundCampaign = false;

    // The scheduler can collect source summaries after the user closes the
    // browser.  Service-role access is accepted only for a matching durable
    // campaign job; all interactive requests still require a user JWT.
    if (backgroundJobId && authHeader === `Bearer ${supabaseServiceKey}`) {
      if (!body.workspace_id || body.background_job_id !== backgroundJobId) return errorResponse('Unauthorized background campaign request', 401);
      const { data: job, error: jobError } = await supabase
        .from('content_generation_jobs')
        .select('user_id, workspace_id')
        .eq('id', backgroundJobId)
        .eq('workspace_id', body.workspace_id)
        .maybeSingle();
      if (jobError || !job) return errorResponse('Unauthorized background campaign request', 401);
      callerId = job.user_id;
      isBackgroundCampaign = true;
    } else {
      const { data: authData, error: authError } = await supabase.auth.getUser(authHeader.slice(7));
      if (authError || !authData.user) return errorResponse(`Unauthorized: ${authError?.message ?? 'token did not resolve to a user'}`, 401);
      callerId = authData.user.id;
    }

    const url = new URL(req.url);
    const action = url.searchParams.get('action') || 'fetch';

    if (!body.workspace_id) return errorResponse('workspace_id is required', 400);
    if (!isBackgroundCampaign && !(await isWorkspaceMember(supabase, body.workspace_id, callerId))) return errorResponse('Forbidden', 403);

    if (action === 'fetch') {
      return await handleFetch(supabase, supabaseUrl, authHeader, body.workspace_id, body.source_ids, backgroundJobId ?? undefined);
    }
    if (action === 'mark-processed') {
      if (!body.source_id || !body.content_hash) return errorResponse('source_id and content_hash are required', 400);
      return await handleMarkProcessed(supabase, body.workspace_id, body.source_id, body.content_hash);
    }
    return errorResponse('Unknown action. Use ?action=fetch|mark-processed', 400);
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : 'Internal server error', 500);
  }
});
