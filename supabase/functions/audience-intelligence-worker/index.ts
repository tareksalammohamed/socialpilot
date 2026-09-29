import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

type AudienceInferenceJob = {
  id: string;
  workspace_id: string;
  requested_by: string;
  requested_revision: number;
  attempt_count: number;
};

type AudienceProfilePayload = {
  persona: string;
  pain_points: string[];
  desires: string[];
  motivations: string[];
  objections: string[];
  awareness_level: 'unaware' | 'problem_aware' | 'solution_aware' | 'product_aware' | 'most_aware' | null;
  interests: string[];
  preferred_content: string[];
  language_style: string | null;
  purchase_intent: 'low' | 'medium' | 'high' | null;
};

const WORKER_TIMEOUT_MS = 90_000;
const MAX_LIST_ITEMS = 8;
const MAX_ITEM_LENGTH = 160;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
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

function cleanText(value: unknown, maxLength = MAX_ITEM_LENGTH): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength) : '';
}

function cleanList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value
    .map((item) => cleanText(item))
    .filter((item) => item.length > 0)
    .filter((item) => {
      const key = item.toLocaleLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MAX_LIST_ITEMS);
}

function isUsablePlainPersona(value: string): boolean {
  if (value.length < 24 || value.length > 400) return false;
  const normalized = value.toLocaleLowerCase();
  return !/(?:\bi(?:'m| am)? sorry\b|\bi cannot\b|\bi can't\b|\bunable to\b|as an ai|\bthinking process\b|\banalysis\b|\breasoning\b|\bstep\s+\d+\b|لا أستطيع|لا يمكنني|عذرًا|اعتذر|عملية التفكير|خطوات التفكير|تحليل المدخلات)/i.test(normalized);
}

function conservativeFallbackProfile(brand: Record<string, unknown> | null): AudienceProfilePayload {
  const brandText = [brand?.business_name, brand?.description, brand?.industry, brand?.writing_style, brand?.tone]
    .map((value) => cleanText(value, 600))
    .join(' ');
  const usesArabic = /[\u0600-\u06FF]/.test(brandText);
  return {
    persona: usesArabic
      ? 'جمهور واسع يبحث عن محتوى عملي وإرشاد موثوق ضمن نطاق خبرة العلامة التجارية.'
      : 'A broad audience seeking practical content and trusted guidance within the brand’s stated area of expertise.',
    pain_points: [],
    desires: [],
    motivations: [],
    objections: [],
    awareness_level: null,
    interests: [],
    preferred_content: [],
    language_style: null,
    purchase_intent: null,
  };
}

function plainTextProfile(raw: string): AudienceProfilePayload | null {
  const compact = raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#{}`*_]/g, ' ')
    .replace(/^\s*[-•]\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  const persona = cleanText(compact, 350);
  if (!isUsablePlainPersona(persona)) return null;

  // Some OpenAI-compatible free models occasionally honor the task but ignore
  // the JSON-only wrapper. Preserve a concise, non-sensitive persona instead
  // of discarding an otherwise usable inference; fields without explicit
  // structure remain empty rather than being guessed.
  return {
    persona,
    pain_points: [],
    desires: [],
    motivations: [],
    objections: [],
    awareness_level: null,
    interests: [],
    preferred_content: [],
    language_style: null,
    purchase_intent: null,
  };
}

function parseProfile(raw: string, fallbackProfile: AudienceProfilePayload): AudienceProfilePayload {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) {
    const plainProfile = plainTextProfile(raw);
    if (plainProfile) return plainProfile;
    return fallbackProfile;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    const plainProfile = plainTextProfile(raw);
    if (plainProfile) return plainProfile;
    return fallbackProfile;
  }
  const persona = cleanText(parsed.persona, 350);
  if (!persona) throw new Error('Audience model returned no persona');

  const awareness = cleanText(parsed.awareness_level, 40);
  const purchaseIntent = cleanText(parsed.purchase_intent, 20);
  return {
    persona,
    pain_points: cleanList(parsed.pain_points),
    desires: cleanList(parsed.desires),
    motivations: cleanList(parsed.motivations),
    objections: cleanList(parsed.objections),
    awareness_level: ['unaware', 'problem_aware', 'solution_aware', 'product_aware', 'most_aware'].includes(awareness)
      ? awareness as AudienceProfilePayload['awareness_level']
      : null,
    interests: cleanList(parsed.interests),
    preferred_content: cleanList(parsed.preferred_content),
    language_style: cleanText(parsed.language_style, 160) || null,
    purchase_intent: ['low', 'medium', 'high'].includes(purchaseIntent)
      ? purchaseIntent as AudienceProfilePayload['purchase_intent']
      : null,
  };
}

function hasBrandContext(brand: Record<string, unknown> | null): boolean {
  return Boolean(
    cleanText(brand?.business_name) || cleanText(brand?.description) || cleanText(brand?.industry) || cleanList(brand?.keywords).length,
  );
}

Deno.serve(async (req: Request) => {
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  if (!serviceKey || !supabaseUrl) return jsonResponse({ error: 'Server configuration is incomplete' }, 500);
  if (req.headers.get('Authorization') !== `Bearer ${serviceKey}`) return jsonResponse({ error: 'Unauthorized' }, 401);

  const supabase = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  const workerId = `audience-worker-${crypto.randomUUID()}`;

  // Periodic discovery catches existing workspaces and new learning signals;
  // actual processing remains bounded to a single locked job per scheduler tick.
  try {
    const { error: enqueueError } = await supabase.rpc('enqueue_due_audience_inferences', { p_limit: 3 });
    if (enqueueError) console.error('audience-intelligence-worker could not enqueue due inferences', enqueueError);
  } catch (error) {
    console.error('audience-intelligence-worker could not enqueue due inferences', error);
  }

  const { data: claimed, error: claimError } = await supabase.rpc('claim_audience_inference_job', { p_worker_id: workerId });
  if (claimError) return jsonResponse({ error: claimError.message }, 500);
  const job = (Array.isArray(claimed) ? claimed[0] : claimed) as AudienceInferenceJob | null;
  if (!job) return jsonResponse({ processed: false, reason: 'queue_empty' });

  try {
    const [brandResult, learningsResult, patternsResult] = await Promise.all([
      supabase
        .from('brand_voice')
        .select('business_name, description, industry, writing_style, tone, keywords, negative_keywords, cta_style, emoji_style, formality, voice, sentence_style, hook_style, hashtag_policy, content_length, brand_values, audience_relationship')
        .eq('workspace_id', job.workspace_id)
        .maybeSingle(),
      supabase
        .from('content_learnings')
        .select('id, learning, evidence, scope, confidence, sample_size, updated_at')
        .eq('workspace_id', job.workspace_id)
        .eq('status', 'ACTIVE')
        .gte('confidence', 0.65)
        .gte('sample_size', 5)
        .order('updated_at', { ascending: false })
        .limit(12),
      supabase
        .from('content_patterns')
        .select('dimension, value, lift, confidence, sample_size, updated_at')
        .eq('workspace_id', job.workspace_id)
        .eq('status', 'ACTIVE')
        .gte('confidence', 0.65)
        .order('updated_at', { ascending: false })
        .limit(12),
    ]);

    if (brandResult.error) throw brandResult.error;
    if (learningsResult.error) throw learningsResult.error;
    if (patternsResult.error) throw patternsResult.error;

    const brand = (brandResult.data ?? null) as Record<string, unknown> | null;
    if (!hasBrandContext(brand)) {
      await Promise.all([
        supabase
          .from('audience_profiles')
          .update({ inference_status: 'needs_brand_context', inference_error: null, updated_at: new Date().toISOString() })
          .eq('workspace_id', job.workspace_id),
        supabase
          .from('audience_inference_jobs')
          .update({ status: 'complete', completed_at: new Date().toISOString(), locked_at: null, locked_by: null, error: null })
          .eq('id', job.id)
          .eq('locked_by', workerId),
      ]);
      return jsonResponse({ processed: true, job_id: job.id, status: 'needs_brand_context' });
    }

    const learnings = learningsResult.data ?? [];
    const patterns = patternsResult.data ?? [];
    const latestLearningAt = learnings.reduce<string | null>((latest, item) => {
      const value = typeof item.updated_at === 'string' ? item.updated_at : null;
      return value && (!latest || value > latest) ? value : latest;
    }, null);

    const evidence = {
      source: 'brand_voice_and_learning_engine',
      brand_fields: Object.entries(brand ?? {})
        .filter(([, value]) => cleanText(value) || cleanList(value).length)
        .map(([key]) => key),
      active_learning_count: learnings.length,
      active_pattern_count: patterns.length,
      learning_ids: learnings.map((item) => item.id),
      generated_at: new Date().toISOString(),
    };

    const messages = [
      {
        role: 'system',
        content: `You are SocialPilot's Audience Intelligence engine. Infer a conservative, useful audience profile from the supplied brand identity and validated performance learnings. Return ONLY a valid JSON object with exactly these keys: persona, pain_points, desires, motivations, objections, awareness_level, interests, preferred_content, language_style, purchase_intent.\n\nRules:\n- Use only behavioural, professional, content, and decision signals that are supported by the supplied inputs.\n- Never infer or include sensitive personal attributes, including age, gender, ethnicity, religion, health, disability, political belief, sexuality, precise location, or income.\n- Do not invent market facts, customer segments, or demographics. When evidence is weak, write a broad cautious persona and use empty arrays/null rather than speculation.\n- Arrays contain at most 8 concise strings.\n- awareness_level must be one of: unaware, problem_aware, solution_aware, product_aware, most_aware, or null.\n- purchase_intent must be one of: low, medium, high, or null.\n- Match the language used in the Brand Voice inputs.
- The first character of your response must be { and the final character must be }. Do not use Markdown, commentary, or code fences.`,
      },
      {
        role: 'user',
        content: JSON.stringify({ brand_voice: brand, validated_learnings: learnings, validated_patterns: patterns }),
      },
    ];

    const aiResponse = await fetchWithTimeout(
      `${supabaseUrl}/functions/v1/ai-gateway?action=chat`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${serviceKey}`,
          'Content-Type': 'application/json',
          'X-Audience-Inference-Job': job.id,
        },
        body: JSON.stringify({
          workspace_id: job.workspace_id,
          background_job_id: job.id,
          messages,
          temperature: 0.2,
          max_tokens: 900,
          stream: false,
        }),
      },
      WORKER_TIMEOUT_MS,
    );
    if (!aiResponse.ok) throw new Error(`Audience intelligence request failed (${aiResponse.status}): ${(await aiResponse.text()).slice(0, 500)}`);

    const aiPayload = await aiResponse.json() as { content?: string; choices?: Array<{ message?: { content?: string } }> };
    const profile = parseProfile(
      String(aiPayload.content ?? aiPayload.choices?.[0]?.message?.content ?? ''),
      conservativeFallbackProfile(brand),
    );

    const { data: completed, error: completionError } = await supabase.rpc('complete_audience_inference_job', {
      p_job_id: job.id,
      p_requested_revision: job.requested_revision,
      p_worker_id: workerId,
      p_profile: profile,
      p_evidence: evidence,
      p_learning_refreshed_at: latestLearningAt,
    });
    if (completionError) throw completionError;

    return jsonResponse({ processed: true, job_id: job.id, completed: completed === true, status: completed ? 'ready' : 'superseded' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('audience-intelligence-worker failed', job.id, message);
    await supabase.rpc('fail_audience_inference_job', {
      p_job_id: job.id,
      p_worker_id: workerId,
      p_error: message,
    });
    return jsonResponse({ processed: true, job_id: job.id, status: 'retrying', error: message }, 200);
  }
});
