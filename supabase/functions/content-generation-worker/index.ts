import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';

type CampaignPlan = {
  objective?: string;
  audience?: string;
  platforms?: string[];
  post_count?: number;
  use_content_sources?: boolean;
};

type GenerationJob = {
  id: string;
  workspace_id: string;
  user_id: string;
  status: string;
  phase: string;
  request_text: string;
  plan: CampaignPlan | null;
  post_count: number;
  next_index: number;
  source_context: string | null;
  used_sources: Array<{ source_id: string; source_name: string | null; title: string; content_hash?: string }> | null;
  images_enabled: boolean;
  schedule_times: string[] | null;
};

type GenerationResult = {
  content: string;
  title?: string;
  quality_score?: number;
  approved: boolean;
};

const IMAGE_TIMEOUT_MS = 45_000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function titleFromContent(content: string): string {
  const first = content.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? 'AI Generated Post';
  return first.replace(/^#+\s*/, '').slice(0, 120);
}

// When the model is asked for JSON but instead free-writes its reasoning
// (walking through the prompt/instructions, second-guessing itself, listing
// numbered analysis steps), JSON.parse below fails and — before this guard
// existed — the *entire raw reasoning dump* was saved into posts.content as
// a "draft ready for review". None of the quality guards in
// src/engines/contentEngine/contentGuards.ts run in this worker at all, so
// nothing else was catching it. This is a narrow, deliberately
// over-inclusive detector for exactly that shape of text: it only needs to
// stop obvious chain-of-thought narration from ever reaching `posts`, not
// judge borderline content — real posts don't talk about "the user" or
// "the JSON keys" in the third person.
const REASONING_LEAK_PATTERNS: RegExp[] = [
  /^\s*here'?s a thinking process/i,
  /^\s*let'?s (?:re-?read|think|analyze)/im,
  /\bthe user (?:wants|wrote|said|asked|is asking)\b/i,
  /\b(?:system prompt|the json keys?|minified json)\b/i,
  /^\s*\d+\.\s*\*\*[^*]+\*\*/m, // numbered "1. **Analyze User Input:**"-style meta steps
  /^\s*(?:wait|hmm|actually),?\s/im,
  /\bI'll (?:assume|treat it as|produce|generate)\b/i,
  /المستخدم (?:عايز|طلب|كتب|قال)/,
  /دعني أفكر|خلني أفكر|خطوات التفكير|عملية التفكير/,
];

function looksLikeReasoningLeak(text: string): boolean {
  const hits = REASONING_LEAK_PATTERNS.filter((re) => re.test(text)).length;
  return hits >= 2;
}

const THINK_BLOCK_RE = /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi;
const UNCLOSED_THINK_RE = /<think(?:ing)?>[\s\S]*$/i;

function stripThinkTags(text: string): string {
  return text.replace(THINK_BLOCK_RE, '').replace(UNCLOSED_THINK_RE, '').trim();
}

function parseResult(raw: string): GenerationResult {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    const content = typeof parsed.content === 'string' ? stripThinkTags(parsed.content.trim()) : '';
    if (!content) throw new Error('AI returned no post content');
    return {
      content,
      title: typeof parsed.title === 'string' ? parsed.title : undefined,
      quality_score: typeof parsed.quality_score === 'number' ? parsed.quality_score : undefined,
      approved: parsed.approved === true,
    };
  } catch {
    // Not valid JSON. A genuinely plain-text provider response (no JSON,
    // just the post text) is still reviewable content worth keeping — but a
    // chain-of-thought reasoning dump is not a post in any form, reviewable
    // or otherwise, and must never be written to `posts.content`. Fail the
    // generation instead so the job can be retried against another
    // model/provider, the same way an empty or echoed response already is
    // upstream in the AI Gateway.
    if (!cleaned) throw new Error('AI returned no post content');
    if (looksLikeReasoningLeak(cleaned)) {
      throw new Error('AI returned its internal reasoning instead of post content');
    }
    return { content: cleaned, approved: false };
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function generateCampaignImage(
  // The production worker writes to media_items, which is intentionally untyped here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  job: GenerationJob,
  plan: CampaignPlan,
  content: string,
): Promise<string | null> {
  if (!job.images_enabled) return null;

  const prompt = `Professional, brand-safe social media photo. Campaign: ${plan.objective ?? 'social campaign'}. Audience: ${plan.audience ?? 'target audience'}. Context: ${content.slice(0, 200)}. No embedded text, no watermark, no logos.`;
  const seed = Math.floor(Math.random() * 1_000_000_000);
  const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${seed}`;

  try {
    const response = await fetchWithTimeout(imageUrl, { method: 'GET' }, IMAGE_TIMEOUT_MS);
    if (!response.ok) throw new Error(`Image generation failed (${response.status})`);
    const bytes = await response.arrayBuffer();
    const path = `${job.workspace_id}/ai-generated/${Date.now()}-${seed}.png`;
    const { error: uploadError } = await supabase.storage.from('media').upload(path, bytes, {
      contentType: 'image/png',
      upsert: false,
    });
    if (uploadError) throw uploadError;

    const { data: urlData } = supabase.storage.from('media').getPublicUrl(path);
    const url = urlData.publicUrl;
    await supabase.from('media_items').insert({
      workspace_id: job.workspace_id,
      user_id: job.user_id,
      name: `${(plan.objective ?? 'AI campaign').slice(0, 40)} — AI image`,
      type: 'image',
      url,
      mime_type: 'image/png',
      tags: ['ai-generated', 'assistant', 'campaign'],
      metadata: { content_generation_job_id: job.id },
    });
    return url;
  } catch (error) {
    // Images are an optional enhancement; never make a durable text campaign
    // fail because an image provider is slow or temporarily unavailable.
    console.error('content-generation-worker image generation failed', job.id, error);
    return null;
  }
}

async function collectSourceContext(
  supabaseUrl: string,
  serviceKey: string,
  job: GenerationJob,
): Promise<{ context: string; used: GenerationJob['used_sources'] }> {
  const response = await fetchWithTimeout(
    `${supabaseUrl}/functions/v1/content-extraction?action=fetch`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        'X-Content-Generation-Job': job.id,
      },
      body: JSON.stringify({ workspace_id: job.workspace_id, background_job_id: job.id }),
    },
    60_000,
  );
  if (!response.ok) throw new Error(`Content-source collection failed (${response.status}): ${(await response.text()).slice(0, 500)}`);

  const payload = await response.json() as {
    items?: Array<{ source_id: string; source_name: string | null; title: string; summary: string; content_hash?: string }>;
  };
  const items = payload.items ?? [];
  const used = items.map((item) => ({
    source_id: item.source_id,
    source_name: item.source_name,
    title: item.title,
    content_hash: item.content_hash,
  }));
  const context = items.map((item) => `## ${item.title}\n${item.summary}`).join('\n\n').slice(0, 12_000);
  return { context, used };
}

async function markSourcesProcessed(supabaseUrl: string, serviceKey: string, job: GenerationJob): Promise<void> {
  const uniqueSources = new Map<string, string>();
  for (const source of job.used_sources ?? []) {
    if (source.content_hash) uniqueSources.set(source.source_id, source.content_hash);
  }

  for (const [sourceId, contentHash] of uniqueSources.entries()) {
    try {
      await fetchWithTimeout(
        `${supabaseUrl}/functions/v1/content-extraction?action=mark-processed`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${serviceKey}`,
            'Content-Type': 'application/json',
            'X-Content-Generation-Job': job.id,
          },
          body: JSON.stringify({
            workspace_id: job.workspace_id,
            background_job_id: job.id,
            source_id: sourceId,
            content_hash: contentHash,
          }),
        },
        20_000,
      );
    } catch (error) {
      console.error('content-generation-worker could not mark source as processed', sourceId, error);
    }
  }
}

Deno.serve(async (req: Request) => {
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!serviceKey || req.headers.get('Authorization') !== `Bearer ${serviceKey}`) return jsonResponse({ error: 'Unauthorized' }, 401);
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  if (!supabaseUrl) return jsonResponse({ error: 'SUPABASE_URL is missing' }, 500);

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const workerId = `content-worker-${crypto.randomUUID()}`;
  const { data: claimed, error: claimError } = await supabase.rpc('claim_content_generation_job', { p_worker_id: workerId });
  if (claimError) return jsonResponse({ error: claimError.message }, 500);

  const job = (Array.isArray(claimed) ? claimed[0] : claimed) as GenerationJob | null;
  if (!job) return jsonResponse({ processed: false, reason: 'queue_empty' });

  const index = Number(job.next_index ?? 0);
  try {
    const plan = job.plan ?? {};
    let sourceContext = job.source_context ?? '';

    if (plan.use_content_sources && !sourceContext) {
      await supabase
        .from('content_generation_jobs')
        .update({ status: 'collecting', phase: 'collecting', last_error: null, updated_at: new Date().toISOString() })
        .eq('id', job.id);
      const collected = await collectSourceContext(supabaseUrl, serviceKey, job);
      sourceContext = collected.context;
      job.used_sources = collected.used;
      await supabase
        .from('content_generation_jobs')
        .update({ source_context: sourceContext || null, used_sources: collected.used ?? [], status: 'creating', phase: 'creating', last_error: null, updated_at: new Date().toISOString() })
        .eq('id', job.id);
    } else {
      await supabase
        .from('content_generation_jobs')
        .update({ status: 'creating', phase: 'creating', last_error: null, updated_at: new Date().toISOString() })
        .eq('id', job.id);
    }

    // A retry must never create a duplicate post for the same campaign index.
    const { data: existing, error: existingError } = await supabase
      .from('posts')
      .select('id')
      .eq('workspace_id', job.workspace_id)
      .contains('metadata', { content_generation_job_id: job.id, content_generation_index: index })
      .limit(1);
    if (existingError) throw existingError;
    if (existing?.length) {
      const next = index + 1;
      const completed = next >= Number(job.post_count);
      await supabase.rpc('touch_content_generation_job', {
        p_job_id: job.id,
        p_status: completed ? 'completed' : 'queued',
        p_phase: completed ? 'review' : 'creating',
        p_next_index: next,
        p_error: null,
      });
      if (completed) await markSourcesProcessed(supabaseUrl, serviceKey, job);
      return jsonResponse({ processed: true, idempotent: true, job_id: job.id, index, completed });
    }

    const platforms = Array.isArray(plan.platforms) ? plan.platforms.filter((value): value is string => typeof value === 'string') : [];
    const objective = plan.objective || 'Create a professional social media post';
    const audience = plan.audience || 'the target audience';
    const messages = [
      {
        role: 'system',
        content: 'You are SocialPilot Content Agent. Return ONLY valid minified JSON with keys: title, content, quality_score, approved. Write original, platform-appropriate content. Do not invent facts beyond the supplied source context. approved is true only when the content is publish-ready.',
      },
      {
        role: 'user',
        content: `${job.request_text}\n\nObjective: ${objective}\nAudience: ${audience}\nPlatforms: ${platforms.join(', ') || 'social media'}\nPost number: ${index + 1} of ${job.post_count}\n\nSource context:\n${sourceContext || 'No external source context was requested.'}`,
      },
    ];

    const aiResponse = await fetchWithTimeout(
      `${supabaseUrl}/functions/v1/ai-gateway`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
          'X-Content-Generation-Job': job.id,
        },
        body: JSON.stringify({
          workspace_id: job.workspace_id,
          background_job_id: job.id,
          messages,
          temperature: 0.7,
          max_tokens: 1200,
          stream: false,
        }),
      },
      60_000,
    );
    if (!aiResponse.ok) throw new Error((await aiResponse.text()).slice(0, 500));
    const aiPayload = await aiResponse.json() as { content?: string; choices?: Array<{ message?: { content?: string } }> };
    const result = parseResult(String(aiPayload.content ?? aiPayload.choices?.[0]?.message?.content ?? ''));
    const imageUrl = await generateCampaignImage(supabase, job, plan, result.content);
    const next = index + 1;
    const completed = next >= Number(job.post_count);
    const quality = result.quality_score == null
      ? null
      : { approved: result.approved, score: result.quality_score, issues: [], suggestions: [] };
    const scheduledFor = Array.isArray(job.schedule_times) ? job.schedule_times[index] ?? null : null;

    const { error: insertError } = await supabase.from('posts').insert({
      workspace_id: job.workspace_id,
      user_id: job.user_id,
      title: result.title || titleFromContent(result.content),
      content: result.content,
      platforms,
      media_urls: imageUrl ? [imageUrl] : [],
      status: 'draft',
      scheduled_for: scheduledFor,
      metadata: {
        content_workflow: {
          source: 'ai_assistant_background',
          source_label: 'AI Assistant',
          stage: result.approved ? 'approved' : 'in_review',
          quality_status: result.approved ? 'approved' : 'in_review',
          quality,
          needs_review: !result.approved,
          generated_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        assistant: {
          source_request: job.request_text,
          plan,
          quality,
          approved: result.approved,
          needs_review: !result.approved,
          quality_error: result.quality_score == null,
        },
        content_generation_job_id: job.id,
        content_generation_index: index,
      },
    });
    if (insertError) throw insertError;

    await supabase.rpc('touch_content_generation_job', {
      p_job_id: job.id,
      p_status: completed ? 'completed' : 'queued',
      p_phase: completed ? 'review' : 'creating',
      p_next_index: next,
      p_error: null,
    });
    if (completed) await markSourcesProcessed(supabaseUrl, serviceKey, job);

    return jsonResponse({ processed: true, job_id: job.id, index, completed });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Do not strand a campaign after a transient provider/network problem.
    // The scheduler will claim it again once the current lock is released.
    await supabase.rpc('touch_content_generation_job', {
      p_job_id: job.id,
      p_status: 'queued',
      p_phase: index === 0 && job.plan?.use_content_sources && !job.source_context ? 'collecting' : 'creating',
      p_next_index: index,
      p_error: message.slice(0, 1000),
    });
    console.error('content-generation-worker failed', job.id, message);
    return jsonResponse({ processed: false, job_id: job.id, error: message }, 500);
  }
});
