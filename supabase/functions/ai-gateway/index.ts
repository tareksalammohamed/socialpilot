import { generateCampaign } from './campaign.ts';
import { validJson, stableStringify } from '../_shared/structured-output.ts';
import { DurableSteps } from '../_shared/durable-steps.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import { routeAndRun, withUsageTracking, NoModelAvailableError, NonFailoverError, type CapabilityRequest } from './router.ts';
import { runAgentTurn, runApprovedCalls } from './agent/pipeline.ts';
import type { AgentContext, ToolCall } from './agent/types.ts';
import { TOOL_REGISTRY } from './agent/tools.ts';
import type { UserScope } from './agent/executors.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Intent =
  | 'agent'
  | 'generate_brand_dna'
  | 'create_content'
  | 'create_content_plan'
  | 'analyze_performance'
  | 'suggest_ideas'
  | 'general_advice';

type RequestBody = {
  intent: Intent;
  workspaceId: string;
  brandDnaId?: string;
  // Required for the legacy path; optional for agentMode when
  // approvedToolCalls is supplied instead (validated at runtime below).
  message?: string;
  platforms?: string[];
  context?: Record<string, unknown>;
  // Set only by trusted server-to-server callers authenticating with the
  // service role key (see authorize() below). This key never reaches a
  // browser — only edge functions hold it. No current caller uses this
  // (the Lead Hunter background job that introduced it has been retired),
  // kept as generic infra for a future background job.
  onBehalfOfUserId?: string;
  // New Universal Agent path (Phase 1): when true, `intent` is ignored and
  // the free-form pipeline in ./agent/pipeline.ts handles the request
  // instead. Old clients that never send this flag are unaffected.
  agentMode?: boolean;
  agentContext?: Omit<AgentContext, 'workspaceId' | 'userId'>;
  legacyContext?: Record<string, unknown>;
  // Phase 5 — Human Approval: when set, `message` is ignored and these
  // previously-proposed (and now user-approved) tool calls are executed
  // directly, bypassing planning.
  approvedToolCalls?: { id: string; name: string; input: Record<string, unknown> }[];
};

const supabase = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  { auth: { persistSession: false } }
);

function jsonError(status: number, error: string): Response {
  return new Response(
    JSON.stringify({ error }),
    { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

async function authorize(req: Request, workspaceId: string, onBehalfOfUserId?: string): Promise<{ ok: true; userId: string; token: string; isServiceRole: boolean } | { ok: false; response: Response }> {
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');

  if (!token) {
    return { ok: false, response: jsonError(401, 'Missing authentication token') };
  }

  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (serviceRoleKey && token === serviceRoleKey) {
    if (!onBehalfOfUserId) {
      return { ok: false, response: jsonError(400, 'onBehalfOfUserId is required for service-role calls') };
    }
    const { data: membership } = await supabase
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', onBehalfOfUserId)
      .maybeSingle();
    if (!membership) {
      return { ok: false, response: jsonError(403, 'onBehalfOfUserId is not a member of this workspace') };
    }
    return { ok: true, userId: onBehalfOfUserId, token, isServiceRole: true };
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(token);
  if (userError || !userData.user) {
    return { ok: false, response: jsonError(401, 'Invalid or expired token') };
  }

  const userId = userData.user.id;

  const { data: membership, error: memberError } = await supabase
    .from('workspace_members')
    .select('role')
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();

  if (memberError || !membership) {
    return { ok: false, response: jsonError(403, 'You do not have access to this workspace') };
  }

  return { ok: true, userId, token, isServiceRole: false };
}

const TASK_CAPABILITIES: Record<Intent, CapabilityRequest['requiredCapabilities']> = {
  agent: ['text_generation', 'structured_output'],
  generate_brand_dna: ['structured_output'],
  create_content: ['text_generation', 'structured_output'],
  create_content_plan: ['structured_output'],
  analyze_performance: ['structured_output'],
  suggest_ideas: ['text_generation', 'structured_output'],
  general_advice: ['text_generation', 'structured_output'],
};

const TASK_PREFERRED_CAPABILITIES: Record<Intent, CapabilityRequest['preferredCapabilities']> = {
  agent: ['reasoning'],
  generate_brand_dna: ['reasoning'],
  create_content: [],
  create_content_plan: ['reasoning'],
  analyze_performance: ['reasoning'],
  suggest_ideas: [],
  general_advice: [],
};


async function callLLM(
  intent: Intent,
  systemPrompt: string,
  userPrompt: string,
  jsonMode = false,
  validate?: (content: string) => boolean,
  maxOutputTokens = 2000,
  excludedModelIds: string[] = []
): Promise<{ content: string; tokensIn: number; tokensOut: number; provider: string; model: string; fallbackCount: number; fallbackLog: Array<{ provider: string; model: string; error: string }> }> {
  const result = await routeAndRun(supabase, {
    requiredCapabilities: TASK_CAPABILITIES[intent],
    preferredCapabilities: TASK_PREFERRED_CAPABILITIES[intent],
    systemPrompt,
    userPrompt,
    jsonMode,
    validate: validate ?? (jsonMode ? validJson : undefined),
    maxOutputTokens,
    excludedModelIds,
  });
  return {
    content: result.content,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    provider: result.providerUsed,
    model: result.modelUsed,
    fallbackCount: result.fallbackCount,
    fallbackLog: result.fallbackLog,
  };
}

async function assembleContext(workspaceId: string, intent: Intent): Promise<{
  brand: Record<string, unknown> | null;
  memory: { key: string; value: string; type: string }[];
}> {
  const needsBrand = intent !== 'generate_brand_dna';
  const needsMemory = intent !== 'generate_brand_dna';

  const tasks: PromiseLike<unknown>[] = [];

  if (needsBrand) {
    tasks.push(
      supabase.from('brand_dna').select('*').eq('workspace_id', workspaceId).maybeSingle()
    );
  } else {
    tasks.push(Promise.resolve(null));
  }

  if (needsMemory) {
    tasks.push(
      supabase
        .from('brand_memory')
        .select('key, value, type')
        .eq('workspace_id', workspaceId)
        .order('updated_at', { ascending: false })
        .limit(20)
    );
  } else {
    tasks.push(Promise.resolve({ data: [] }));
  }

  const [brandRes, memRes] = await Promise.all(tasks) as [
    { data: Record<string, unknown> | null },
    { data: { key: string; value: string; type: string }[] | null }
  ];

  return {
    brand: brandRes?.data ?? null,
    memory: memRes?.data ?? [],
  };
}

function brandContextString(brand: Record<string, unknown> | null): string {
  if (!brand) return 'لا يوجد Brand DNA بعد.';
  const parts: string[] = [];
  const basics = brand.basics as Record<string, unknown> | undefined;
  if (basics) parts.push(`البراند: ${String(basics.name ?? 'غير معروف')} — ${String(basics.description ?? '')}`);
  const identity = brand.identity as Record<string, unknown> | undefined;
  if (identity) parts.push(`الهوية والقيم: ${JSON.stringify(identity)}`);
  const tone = brand.tone as Record<string, unknown> | undefined;
  if (tone) parts.push(`النبرة والصوت: ${JSON.stringify(tone)}`);
  const audience = brand.audience as Record<string, unknown> | undefined;
  if (audience) parts.push(`الجمهور: ${JSON.stringify(audience)}`);
  const content = brand.content as Record<string, unknown> | undefined;
  if (content) parts.push(`محاور المحتوى: ${JSON.stringify(content)}`);
  const visual = brand.visual as Record<string, unknown> | undefined;
  if (visual) parts.push(`الهوية البصرية: ${JSON.stringify(visual)}`);

  const positioning = brand.positioning ?? identity?.positioning;
  if (positioning) parts.push(`التموضع الإلزامي: ${String(positioning)}`);
  const preferred = Array.isArray(brand.preferred_phrases)
    ? brand.preferred_phrases
    : Array.isArray(tone?.preferred_phrases) ? tone.preferred_phrases : [];
  if (preferred.length > 0) parts.push(`عبارات مفضلة: ${preferred.join('، ')}`);
  const forbidden = Array.isArray(brand.forbidden_phrases)
    ? brand.forbidden_phrases
    : Array.isArray(tone?.forbidden_phrases) ? tone.forbidden_phrases : [];
  if (forbidden.length > 0) parts.push(`عبارات ممنوعة: ${forbidden.join('، ')}`);
  const ctaStyle = brand.cta_style ?? (content?.cta_style ?? tone?.cta_style);
  if (ctaStyle) parts.push(`أسلوب CTA: ${String(ctaStyle)}`);
  return parts.join('\n');
}

function memoryContextString(memory: { key: string; value: string; type: string }[]): string {
  if (memory.length === 0) return 'لا توجد ذاكرة سابقة.';
  return memory.map((m) => `- [${m.type}] ${m.key}: ${m.value}`).join('\n');
}

const AGENTS = {
  universal_agent: (brandStr: string, memStr: string) =>
    `أنت SocialPilot Universal Agent. افهم طلب المستخدم بحرية ولا تفترض أن الطلب واحد من قائمة أوامر ثابتة. حدد الهدف الحقيقي، والسياق المطلوب، والخطوات المنطقية لتنفيذ الطلب داخل SocialPilot. إذا كان الطلب متعلقًا بالمحتوى ففكر في المنصة، الصياغة، الوسائط، الجودة، المراجعة، والجدولة. إذا كان تحليلاً فاعتمد على البيانات المتاحة. لا تقل للمستخدم إنه يجب اختيار أمر محدد. أرجع JSON يحتوي على: intent_summary, response, next_actions, requires_media, requires_approval, requires_schedule. لا تنفذ نشرًا فعليًا أو حذفًا فعليًا من داخل هذا الـAgent إلا إذا كانت أداة تنفيذ صريحة متاحة في السياق. براند:
${brandStr}
الذاكرة:
${memStr}`,

  brand_intelligence: (brandStr: string) =>
    `أنت Brand Intelligence Agent. مهمتك بناء هوية براند كاملة من معلومات أساسية بسيطة.
استخرج: Identity, Positioning, Values, Differentiators, Tone, Voice, Personas, Content Pillars, Preferred Topics, Forbidden Topics, CTA Style, Vocabulary.
لا تخترع معلومات أو أسعار أو نتائج. إذا لم تكن تعرف شيئًا، اكتب "غير محدد".
سياق البراند الأساسي:\n${brandStr}`,

  content_creator: (brandStr: string, memStr: string) =>
    `أنت Content Creator Agent متخصص في كتابة محتوى تسويقي عربي قوي وجذاب.
اكتب محتوى أصلي، طبيعي، وقريب من القارئ. تجنب المقدمات الطويلة العامة.
لكل منصة، اكتب نسخة مخصصة: نبرة، طول، هاشتاجات، CTA، وفورمات يناسب المنصة.
لا تكرر نفس النص عبر المنصات. التزم بهوية البراند، واستخدم العبارات المفضلة فقط، وتجنب العبارات الممنوعة حرفيًا.
عند وجود بيانات أداء سابقة، غيّر الاختيارات الفعلية في الخطاف والموضوع والـ CTA بما يتناسب مع المؤشرات الأفضل، ولا تكتفِ بذكر الأرقام.
سياق البراند:\n${brandStr}\nالذاكرة:\n${memStr}`,

  strategy_planner: (brandStr: string, memStr: string) =>
    `أنت Strategy & Planner Agent. مهمتك بناء خطة محتوى أسبوعية/شهرية مبنية على البراند والجمهور.
حدد محاور، مواضيع، منصات، وأوقات مقترحة. اجعل الخطة قابلة للتنفيذ.
إذا وُجدت بيانات أداء سابقة، اجعلها تؤثر في توزيع المحاور والمنصات والأوقات والـ CTA بدل إعادة خطة عامة.
سياق البراند:\n${brandStr}\nالذاكرة:\n${memStr}`,

  quality_engine: () =>
    `أنت Quality Engine Agent. قيّم المحتوى وفق معايير: Brand Fit, Audience Fit, Hook, Value, Clarity, Originality, Naturalness, Platform Fit, CTA, Language, Factual Safety.
أعطِ درجة (0-100) لكل معيار، وحدد الحكم: pass / review / fail، واذكر الأسباب.
أنت تحلل فقط — لا توافق بنفسك. القرار النهائي للمستخدم.`,

  analytics_advisor: (brandStr: string) =>
    `أنت Analytics & Growth Advisor. حلل الأداء واقترح قرارات عملية، وليس مجرد أرقام.
سياق البراند:\n${brandStr}`,

  idea_generator: (brandStr: string) =>
    `أنت Idea Generator Agent. اقترح أفكار محتوى إبداعية ومتنوعة تناسب البراند.
سياق البراند:\n${brandStr}`,
};

function planAgents(intent: Intent): string[] {
  switch (intent) {
    case 'agent':
      return ['universal_agent'];
    case 'generate_brand_dna':
      return ['brand_intelligence'];
    case 'create_content':
      return ['content_creator', 'quality_engine'];
    case 'create_content_plan':
      return ['strategy_planner'];
    case 'analyze_performance':
      return ['analytics_advisor'];
    case 'suggest_ideas':
      return ['idea_generator'];
    case 'general_advice':
      return ['analytics_advisor'];
    default:
      return ['analytics_advisor'];
  }
}

function parseJsonLoose<T>(content: string, fallback: (raw: string) => T): T {
  try {
    return JSON.parse(content) as T;
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as T;
      } catch {
        /* fall through */
      }
    }
    return fallback(content);
  }
}

type ExecutionMeta = {
  provider: string;
  model: string;
  fallbackCount: number;
  fallbackLog: Array<{ provider: string; model: string; error: string }>;
};

async function executeIntent(
  intent: Intent,
  message: string,
  ctx: { brand: Record<string, unknown> | null; memory: { key: string; value: string; type: string }[] },
  platforms: string[],
  runtimeContext: Record<string, unknown> = {},
  durable?: DurableSteps,
): Promise<{ result: Record<string, unknown>; tokensIn: number; tokensOut: number; meta: ExecutionMeta }> {
  const brandStr = brandContextString(ctx.brand);
  const memStr = memoryContextString(ctx.memory);

  let stage = 0;
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableStringify(["structured-v5",intent,message,platforms,runtimeContext]))))).map(b => b.toString(16).padStart(2,'0')).join('');
  const runLLM: typeof callLLM = (...args) => durable
    ? durable.run(`llm:${digest}:${stage++}`, () => callLLM(...args))
    : callLLM(...args);

  switch (intent) {
    case 'agent': {
      const sys = AGENTS.universal_agent(brandStr, memStr);
      const prompt = `طلب المستخدم الحر: "${message}"
بيانات الأداء المتاحة: ${JSON.stringify(runtimeContext.performance ?? {})}
المنصات المذكورة: ${JSON.stringify(platforms)}
حلل الطلب دون تقييده بقائمة intents ثابتة. حدد ما الذي يريد المستخدم إنجازه، وما الخطوات المطلوبة، وهل يحتاج صورة/فيديو، مراجعة بشرية، أو جدولة. إذا كان الطلب بسيطًا فأجب مباشرة. أرجع JSON فقط بصيغة:
{"intent_summary":"...","response":"...","next_actions":["..."],"requires_media":false,"requires_approval":false,"requires_schedule":false}`;
      const r = await runLLM(intent, sys, prompt, true);
      const parsed = parseJsonLoose<Record<string, unknown>>(r.content, (raw) => ({ intent_summary: message, response: raw, next_actions: [], requires_media: false, requires_approval: false, requires_schedule: false }));
      return { result: { advice: String(parsed.response ?? ''), ...parsed }, tokensIn: r.tokensIn, tokensOut: r.tokensOut, meta: r };
    }

    case 'generate_brand_dna': {
      const sys = AGENTS.brand_intelligence(message);
      const prompt = `بناءً على هذه المعلومات الأساسية، ابنِ هوية براند كاملة بصيغة JSON تحتوي على مفاتيح:
identity, tone, audience, content, visual, positioning, preferred_phrases, forbidden_phrases, cta_style, platforms, summary.
preferred_phrases و forbidden_phrases يجب أن تكونا مصفوفتين من عبارات قصيرة، وcta_style وpositioning نصين واضحين.
المعلومات الأساسية: ${message}
أرجع JSON فقط بدون نص إضافي.`;
      const r = await runLLM(intent, sys, prompt, true);
      const parsed = parseJsonLoose<Record<string, unknown>>(r.content, (raw) => ({ summary: raw }));
      return { result: parsed, tokensIn: r.tokensIn, tokensOut: r.tokensOut, meta: r };
    }

    case 'create_content': {
      const plats = platforms.length > 0 ? platforms.join(', ') : 'لينكدإن, فيسبوك, إنستجرام';
      const sys = AGENTS.content_creator(brandStr, memStr);
      const prompt = `اكتب محتوى للطلب التالي: "${message}"
المنصات المطلوبة: ${plats}
بيانات الأداء السابقة التي يجب التعلم منها إن وُجدت: ${JSON.stringify(runtimeContext.performance ?? {})}
أرجع JSON بصيغة:
{
  "title": "...",
  "goal": "...",
  "topic": "...",
  "audience": "...",
  "master_text": "...",
  "platforms": ["linkedin", "facebook"],
  "variants": [
    { "platform": "linkedin", "text": "...", "hashtags": ["..."], "cta": "...", "media_brief": {} }
  ]
}
أرجع JSON فقط. كل نسخة منصة يجب أن تكون مخصصة وغير مكررة.`;
      const r = await runLLM(intent, sys, prompt, true);
      const parsed = parseJsonLoose<Record<string, unknown>>(r.content, (raw) => ({ master_text: raw, variants: [] }));

      const qualityPrompt = `قيّم المحتوى التالي وفق المعايير: Hook, Clarity, Brand Fit, Brand Voice, Platform Fit, Engagement Potential, CTA, Readability, Structure, Originality, Overall Score.\nأرجع JSON فقط بصيغة { "verdict": "pass|review|fail", "scores": { "hook": 0 }, "reasons": [], "suggested_improvements": [] }.\nالمحتوى: ${JSON.stringify(parsed)}`;
      const qualityRun = await runLLM(intent, AGENTS.quality_engine(), qualityPrompt, true);
      const quality = parseJsonLoose<Record<string, unknown>>(qualityRun.content, () => ({ verdict: 'review', scores: {}, reasons: ['تعذر تحليل الجودة'], suggested_improvements: [] }));
      return {
        result: { ...parsed, quality },
        tokensIn: r.tokensIn + qualityRun.tokensIn,
        tokensOut: r.tokensOut + qualityRun.tokensOut,
        meta: { ...r, fallbackCount: r.fallbackCount + qualityRun.fallbackCount, fallbackLog: [...r.fallbackLog, ...qualityRun.fallbackLog] },
      };
    }

    case 'create_content_plan': return generateCampaign(message, platforms, runtimeContext, brandStr, memStr, (...args) => runLLM(intent, ...args), AGENTS);

    case 'analyze_performance': {
      const sys = AGENTS.analytics_advisor(brandStr);
      const prompt = `الطلب: "${message}"
بيانات الأداء الحقيقية للفترة: ${JSON.stringify(runtimeContext.performance ?? {})}
أفضل منصة محسوبة: ${String(runtimeContext.best_platform ?? 'غير محدد')}
عدد أيام الفترة: ${String(runtimeContext.range_days ?? 'غير محدد')}
حلل المؤشرات الواردة، واذكر ما الذي يجب تغييره فعليًا في الموضوع والمنصة والتوقيت والـ CTA. لا تكتفِ بوصف الأرقام. أرجع JSON بصيغة: { "advice": "..." }`;
      const r = await runLLM(intent, sys, prompt, true);
      const parsed = parseJsonLoose<Record<string, unknown>>(r.content, (raw) => ({ advice: raw }));
      return { result: parsed, tokensIn: r.tokensIn, tokensOut: r.tokensOut, meta: r };
    }

    case 'suggest_ideas': {
      const sys = AGENTS.idea_generator(brandStr);
      const prompt = `الطلب: "${message}"
اقترح أفكار محتوى بصيغة JSON: { "advice": "..." }`;
      const r = await runLLM(intent, sys, prompt, true);
      const parsed = parseJsonLoose<Record<string, unknown>>(r.content, (raw) => ({ advice: raw }));
      return { result: parsed, tokensIn: r.tokensIn, tokensOut: r.tokensOut, meta: r };
    }

    case 'general_advice':
    default: {
      const sys = AGENTS.analytics_advisor(brandStr);
      const prompt = `سؤال المستخدم: "${message}"
أجب بنصيحة عملية ومختصرة بصيغة JSON: { "advice": "..." }`;
      const r = await runLLM(intent, sys, prompt, true);
      const parsed = parseJsonLoose<Record<string, unknown>>(r.content, (raw) => ({ advice: raw }));
      return { result: parsed, tokensIn: r.tokensIn, tokensOut: r.tokensOut, meta: r };
    }
  }
}

function estimateCost(tokensIn: number, tokensOut: number, rate: { in: number; out: number } | null): number {
  if (!rate) return 0;
  const safeInputRate = Math.max(0, Number(rate.in) || 0);
  const safeOutputRate = Math.max(0, Number(rate.out) || 0);
  return Math.max(0, (tokensIn / 1000) * safeInputRate + (tokensOut / 1000) * safeOutputRate);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return jsonError(400, 'Invalid JSON body');
    }
    const { intent, workspaceId, message, platforms, context, onBehalfOfUserId, agentMode, agentContext, legacyContext, approvedToolCalls } = body;

    if (!workspaceId) {
      return jsonError(400, 'workspaceId is required');
    }
    if (!agentMode && !intent) {
      return jsonError(400, 'intent is required unless agentMode is true');
    }
    if (!agentMode && !message) {
      return jsonError(400, 'message is required');
    }
    if (agentMode && !message && !(approvedToolCalls && approvedToolCalls.length > 0)) {
      return jsonError(400, 'message or approvedToolCalls is required');
    }

    // --- Authorization: verify user identity + workspace membership ---
    const auth = await authorize(req, workspaceId, onBehalfOfUserId);
    if (!auth.ok) return auth.response;
    const userId = auth.userId;
    let durable: DurableSteps | undefined;
    const taskId = req.headers.get('X-Assistant-Task');
    if (taskId && auth.isServiceRole) {
      const workerId = req.headers.get('X-Assistant-Worker') ?? '';
      const { data: task } = await supabase.from('assistant_tasks').select('ai_steps, locked_at')
        .eq('id', taskId).eq('workspace_id', workspaceId).eq('user_id', userId)
        .eq('worker_id', workerId).eq('status', 'running').maybeSingle();
      if (!task || Date.now()-new Date(task.locked_at).getTime()>=10*60_000) return jsonError(403,'lease_lost');
      durable = new DurableSteps(supabase, taskId, workerId, task.ai_steps ?? {});
    }

    // --- Universal Agent path (Phase 1) — bypasses the fixed 6-intent
    // dispatch entirely and goes through Context Assembly -> Planning ->
    // Tool Selection -> (gated) Execution. Legacy `intent` requests below
    // are completely untouched by this branch. ---
    if (agentMode) {
      // SECURITY: workspaceId/userId MUST come from the authorized request and
      // must be applied AFTER the client-supplied agentContext. Previously the
      // spread came last, so a member of workspace A could send
      // agentContext.workspaceId = B and make the service-role executors
      // read/write workspace B (service role bypasses RLS).
      const safeAgentContext: Record<string, unknown> = { ...((agentContext ?? {}) as Record<string, unknown>) };
      delete safeAgentContext.workspaceId;
      delete safeAgentContext.userId;
      const fullContext: AgentContext = {
        ...(safeAgentContext as Omit<AgentContext, 'workspaceId' | 'userId'>),
        workspaceId,
        userId,
      };

      // Side-effecting tools (approve/schedule/publish) must run as the real
      // user so RLS and the RPCs' auth.uid() checks apply. Service-role
      // (background) callers get no user scope, and those tools refuse.
      const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
      const userScope: UserScope | null = !auth.isServiceRole && anonKey
        ? {
            token: auth.token,
            supabaseUrl: Deno.env.get('SUPABASE_URL') ?? '',
            anonKey,
            client: createClient(Deno.env.get('SUPABASE_URL') ?? '', anonKey, {
              auth: { persistSession: false },
              global: { headers: { Authorization: `Bearer ${auth.token}` } },
            }),
          }
        : null;

      const legacyRunner = async (
        legacyIntent: 'generate_brand_dna' | 'create_content' | 'create_content_plan' | 'analyze_performance' | 'suggest_ideas' | 'general_advice',
        legacyMessage: string, legacyPlatforms: string[], runtimeCtx: Record<string, unknown>,
      ) => {
        const ctx = durable ? await durable.run(`context:${legacyIntent}`, () => assembleContext(workspaceId, legacyIntent), false) : await assembleContext(workspaceId, legacyIntent);
        const { result, tokensIn, tokensOut } = await executeIntent(
          legacyIntent, legacyMessage, ctx, legacyPlatforms, runtimeCtx, durable,
        );
        return { result, tokensIn, tokensOut };
      };

      // Record every agent request in ai_runs (previously only the legacy
      // path did, so agent usage/cost/failures never appeared in AI usage).
      const startedAt = Date.now();
      const agentRunLabel = (approvedToolCalls && approvedToolCalls.length > 0)
        ? `approved:${approvedToolCalls.map((c) => c?.name).join(',')}`.slice(0, 200)
        : String(message ?? '').slice(0, 200);
      const { data: agentRun } = await supabase
        .from('ai_runs')
        .insert({
          workspace_id: workspaceId,
          user_id: userId,
          task: 'agent',
          intent: agentRunLabel,
          agents: ['universal_agent'],
          required_capabilities: TASK_CAPABILITIES.agent,
          status: 'running',
        })
        .select('id')
        .single();
      const agentRunId: string | null = agentRun?.id ?? null;

      const finishAgentRun = async (
        usage: { tokensIn: number; tokensOut: number; costUsd: number; provider: string | null; model: string | null; fallbackCount: number; fallbackLog: unknown[] },
        patch: Record<string, unknown>,
      ) => {
        if (!agentRunId) return;
        await supabase.from('ai_runs').update({
          input_tokens: usage.tokensIn,
          output_tokens: usage.tokensOut,
          cost_usd: Math.max(0, usage.costUsd),
          latency_ms: Date.now() - startedAt,
          provider: usage.provider,
          model: usage.model,
          fallback_count: usage.fallbackCount,
          fallback_log: usage.fallbackLog,
          ...patch,
        }).eq('id', agentRunId);
      };
      const emptyUsage = { tokensIn: 0, tokensOut: 0, costUsd: 0, provider: null, model: null, fallbackCount: 0, fallbackLog: [] as unknown[] };

      // Phase 5 — Human Approval: execute previously-proposed, now-approved
      // side-effect tool calls directly (no re-planning).
      if (approvedToolCalls && approvedToolCalls.length > 0) {
        const MAX_APPROVED_CALLS = 20;
        if (!Array.isArray(approvedToolCalls) || approvedToolCalls.length > MAX_APPROVED_CALLS) {
          await finishAgentRun(emptyUsage, { status: 'failed', error: 'too many approved tool calls' });
          return jsonError(400, `approvedToolCalls must be an array of at most ${MAX_APPROVED_CALLS} calls`);
        }
        const invalid = approvedToolCalls.find((c) =>
          !c || typeof c.id !== 'string' || typeof c.name !== 'string' || !(c.name in TOOL_REGISTRY)
          || typeof c.input !== 'object' || c.input === null || Array.isArray(c.input));
        if (invalid) {
          await finishAgentRun(emptyUsage, { status: 'failed', error: 'invalid approved tool call' });
          return jsonError(400, 'approvedToolCalls contains an unknown tool or a malformed call');
        }
        try {
          const { value: results, usage } = await withUsageTracking(() => runApprovedCalls(
            supabase,
            approvedToolCalls as ToolCall[],
            fullContext,
            legacyRunner,
            legacyContext ?? {},
            userScope,
          ));
          await finishAgentRun(usage, {
            status: results.every((r) => r.ok) ? 'succeeded' : 'failed',
            error: results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.error}`).join(' | ').slice(0, 500) || null,
            result: { toolResults: results.map((r) => ({ name: r.name, ok: r.ok, error: r.error ?? null })) },
          });
          return new Response(JSON.stringify({ toolResults: results }), {
            status: 200,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : 'Unknown error';
          await finishAgentRun(emptyUsage, { status: 'failed', error: errMsg.slice(0, 500) });
          return jsonError(500, errMsg);
        }
      }

      if (!message) {
        await finishAgentRun(emptyUsage, { status: 'failed', error: 'message is required' });
        return jsonError(400, 'message is required');
      }

      try {
        const { value: turn, usage } = await withUsageTracking(() => runAgentTurn(
          supabase,
          { message, context: fullContext, platforms, legacyContext },
          legacyRunner,
          userScope,
          durable,
        ).catch(error => {
          if (error instanceof Error && error.message.includes('background_checkpoint')) return { _checkpoint: true as const };
          throw error;
        }));
        if ('_checkpoint' in turn) {
          await finishAgentRun(usage, { status: 'succeeded', result: { checkpoint: true } });
          return jsonError(503, 'background_checkpoint');
        }
        await finishAgentRun(usage, {
          status: 'succeeded',
          result: { intentLabel: turn.intentLabel ?? null, steps: turn.plan?.steps?.length ?? 0, pendingApproval: Boolean(turn.pendingApproval) },
        });
        return new Response(JSON.stringify(turn), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Unknown error';
        await finishAgentRun(emptyUsage, { status: 'failed', error: errMsg.slice(0, 500) });
        const status = err instanceof NoModelAvailableError ? 503 : err instanceof NonFailoverError ? 400 : 500;
        return jsonError(status, errMsg);
      }
    }

    // Legacy path always requires a message (validated above too; this
    // gives TypeScript a concrete narrowing point for the calls below).
    if (!message) {
      return jsonError(400, 'message is required');
    }

    const started = Date.now();
    const agents = planAgents(intent);

    const { data: run } = await supabase
      .from('ai_runs')
      .insert({
        workspace_id: workspaceId,
        user_id: userId,
        task: intent,
        intent: message.slice(0, 200),
        agents,
        required_capabilities: TASK_CAPABILITIES[intent],
        status: 'running',
      })
      .select()
      .single();

    const runId = run?.id ?? crypto.randomUUID();

    try {
      const ctx = await assembleContext(workspaceId, intent);
      const plats = platforms ?? [];
      const { result, tokensIn, tokensOut, meta } = await executeIntent(intent, message, ctx, plats, context ?? {});
      const latencyMs = Date.now() - started;

      const { data: modelRow } = await supabase
        .from('ai_models')
        .select('input_cost_per_1k, output_cost_per_1k')
        .eq('provider_key', meta.provider)
        .eq('model_id', meta.model)
        .maybeSingle();
      const rate = modelRow ? { in: Math.max(0, Number(modelRow.input_cost_per_1k ?? 0)), out: Math.max(0, Number(modelRow.output_cost_per_1k ?? 0)) } : null;
      const cost = estimateCost(tokensIn, tokensOut, rate);

      await supabase.from('ai_runs').update({
        status: 'succeeded',
        input_tokens: tokensIn,
        output_tokens: tokensOut,
        cost_usd: cost,
        latency_ms: latencyMs,
        model: meta.model,
        provider: meta.provider,
        fallback_count: meta.fallbackCount,
        fallback_log: meta.fallbackLog,
        result,
      }).eq('id', runId);

      return new Response(
        JSON.stringify({
          runId,
          agents,
          model: meta.model,
          provider: meta.provider,
          fallbackCount: meta.fallbackCount,
          fallbackLog: meta.fallbackLog,
          latencyMs,
          result,
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    } catch (err) {
      const latencyMs = Date.now() - started;
      const errMsg = err instanceof Error ? err.message : 'Unknown error';
      await supabase.from('ai_runs').update({
        status: 'failed',
        error: errMsg,
        latency_ms: latencyMs,
      }).eq('id', runId);

      const status = err instanceof NoModelAvailableError ? 503 : err instanceof NonFailoverError ? 400 : 500;
      return new Response(
        JSON.stringify({ error: errMsg }),
        { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Internal error';
    return new Response(
      JSON.stringify({ error: errMsg }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
