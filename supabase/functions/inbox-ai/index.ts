import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

type Body = {
  conversationId?: string;
  action?: 'analyze' | 'approve_reply' | 'reject_reply';
  reply?: string;
  rejectionReason?: string;
  onBehalfOfUserId?: string;
};
type Message = { id: string; direction: 'inbound' | 'outbound'; content: string; sender_name: string | null; created_at: string };
type InboxAiSettings = {
  enabled?: boolean;
  autoAnalyze?: boolean;
  tone?: 'professional' | 'friendly' | 'sales';
  language?: 'ar' | 'auto';
  responseGoal?: string;
  businessContext?: string;
  forbiddenTopics?: string;
  maxReplyLength?: number;
  replyMode?: 'draft' | 'auto_safe';
  autoReplyMaxPerHour?: number;
};

type ParsedAnalysis = {
  intent?: unknown;
  lead_score?: unknown;
  priority?: unknown;
  summary?: unknown;
  suggested_reply?: unknown;
  next_best_action?: unknown;
  quality_verdict?: unknown;
  quality_reasons?: unknown;
  safe_to_auto_reply?: unknown;
  automation_reason?: unknown;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

function parseModelJson(value: unknown): ParsedAnalysis {
  if (typeof value !== 'string') return (value ?? {}) as ParsedAnalysis;
  const cleaned = value.trim().replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(cleaned) as ParsedAnalysis; } catch { return {}; }
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function score(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(100, Math.round(parsed))) : 0;
}

function priority(value: unknown): 'low' | 'normal' | 'high' | 'urgent' {
  return value === 'low' || value === 'high' || value === 'urgent' ? value : 'normal';
}

function verdict(value: unknown): 'pass' | 'review' | 'fail' {
  return value === 'pass' || value === 'fail' ? value : 'review';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  let body: Body;
  try { body = await req.json() as Body; } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }
  if (!body.conversationId) return jsonResponse({ error: 'conversationId is required' }, 400);

  const authHeader = req.headers.get('Authorization') ?? '';
  const userToken = authHeader.replace(/^Bearer\s+/i, '');
  if (!userToken) return jsonResponse({ error: 'Missing authentication token' }, 401);

  let userId = '';
  if (serviceRoleKey && userToken === serviceRoleKey) {
    userId = text(body.onBehalfOfUserId);
    if (!userId) return jsonResponse({ error: 'onBehalfOfUserId is required for service-role calls' }, 400);
  } else {
    const { data: userData, error: userError } = await supabase.auth.getUser(userToken);
    if (userError || !userData.user) return jsonResponse({ error: 'Invalid or expired token' }, 401);
    userId = userData.user.id;
  }

  const { data: conversation, error: conversationError } = await supabase
    .from('inbox_conversations')
    .select('id, workspace_id, platform, type, sender_name, snippet')
    .eq('id', body.conversationId)
    .maybeSingle();
  if (conversationError) return jsonResponse({ error: conversationError.message }, 500);
  if (!conversation) return jsonResponse({ error: 'Conversation not found' }, 404);

  const { data: membership } = await supabase
    .from('workspace_members')
    .select('id')
    .eq('workspace_id', conversation.workspace_id)
    .eq('user_id', userId)
    .maybeSingle();
  if (!membership) return jsonResponse({ error: 'Forbidden' }, 403);

  const { data: workspace } = await supabase
    .from('workspaces')
    .select('name, settings')
    .eq('id', conversation.workspace_id)
    .maybeSingle();
  const workspaceSettings = ((workspace?.settings ?? {}) as Record<string, unknown>);
  const inboxSettings = ((workspaceSettings.inbox_ai ?? {}) as InboxAiSettings);
  if (inboxSettings.enabled === false && body.action !== 'approve_reply' && body.action !== 'reject_reply') {
    return jsonResponse({ error: 'مساعد الذكاء الاصطناعي معطّل من إعدادات صندوق الوارد' }, 409);
  }

  if (body.action === 'approve_reply' || body.action === 'reject_reply') {
    const { data: existing, error: existingError } = await supabase
      .from('inbox_ai_analyses')
      .select('*')
      .eq('conversation_id', conversation.id)
      .eq('workspace_id', conversation.workspace_id)
      .maybeSingle();
    if (existingError) return jsonResponse({ error: existingError.message }, 500);
    if (!existing) return jsonResponse({ error: 'لا يوجد تحليل AI لاعتماده' }, 404);

    if (body.action === 'approve_reply') {
      const approvedReply = text(body.reply ?? existing.suggested_reply);
      if (!approvedReply) return jsonResponse({ error: 'الرد المقترح فارغ' }, 400);
      if (existing.quality_verdict === 'fail') return jsonResponse({ error: 'لا يمكن اعتماد رد فشل في مراجعة الجودة' }, 409);
      const { data: approved, error: approvalError } = await supabase
        .from('inbox_ai_analyses')
        .update({ reply_status: 'approved', approved_reply: approvedReply, approved_by: userId, approved_at: new Date().toISOString(), rejection_reason: null })
        .eq('id', existing.id)
        .eq('workspace_id', conversation.workspace_id)
        .select('*')
        .single();
      if (approvalError) return jsonResponse({ error: approvalError.message }, 500);
      return jsonResponse({ ok: true, analysis: approved, sendsAutomatically: false });
    }

    const { data: rejected, error: rejectionError } = await supabase
      .from('inbox_ai_analyses')
      .update({ reply_status: 'rejected', approved_reply: null, approved_by: null, approved_at: null, rejection_reason: text(body.rejectionReason, 'تم رفض الرد المقترح') })
      .eq('id', existing.id)
      .eq('workspace_id', conversation.workspace_id)
      .select('*')
      .single();
    if (rejectionError) return jsonResponse({ error: rejectionError.message }, 500);
    return jsonResponse({ ok: true, analysis: rejected, sendsAutomatically: false });
  }

  const { data: messages, error: messagesError } = await supabase
    .from('inbox_messages')
    .select('id, direction, content, sender_name, created_at')
    .eq('conversation_id', conversation.id)
    .eq('workspace_id', conversation.workspace_id)
    .order('created_at', { ascending: false })
    .limit(30);
  if (messagesError) return jsonResponse({ error: messagesError.message }, 500);

  const orderedMessages = ((messages ?? []) as Message[]).reverse();
  const transcript = orderedMessages.map((message) => `${message.direction === 'inbound' ? 'CUSTOMER' : 'AGENT'}: ${message.content}`).join('\n');
  const toneLabel = inboxSettings.tone === 'friendly' ? 'ودود وطبيعي' : inboxSettings.tone === 'sales' ? 'بيعي هادئ ومقنع بدون ضغط' : 'احترافي وواضح';
  const languageInstruction = inboxSettings.language === 'auto' ? 'اكتب الرد بنفس لغة العميل الأخيرة.' : 'اكتب الرد باللغة العربية.';
  const maxReplyLength = Math.max(80, Math.min(1000, Math.round(Number(inboxSettings.maxReplyLength ?? 320))));
  const responseGoal = text(inboxSettings.responseGoal, 'حل استفسار العميل بوضوح ثم توجيهه للخطوة التالية المناسبة بدون ضغط أو وعود غير مؤكدة.').slice(0, 2000);
  const businessContext = text(inboxSettings.businessContext).slice(0, 5000);
  const forbiddenTopics = text(inboxSettings.forbiddenTopics).slice(0, 3000);

  const prompt = `حلل محادثة حقيقية من صندوق الرسائل الموحد واقترح ردًا قابلًا للاستخدام. لا تخترع أي معلومة غير موجودة في المحادثة أو سياق النشاط المسموح.
اسم مساحة العمل: ${workspace?.name ?? 'غير محدد'}
المنصة: ${conversation.platform}
النوع: ${conversation.type}
الاسم: ${conversation.sender_name ?? 'غير معروف'}
أسلوب الرد المطلوب: ${toneLabel}
تعليمات اللغة: ${languageInstruction}
هدف الرد: ${responseGoal}
الحد التقريبي لطول الرد: ${maxReplyLength} حرف
سياق النشاط المسموح للـAI استخدامه:
${businessContext || '(لا توجد معلومات إضافية محفوظة)'}

ممنوعات وتعليمات لا يجب تجاوزها:
${forbiddenTopics || '(لا توجد تعليمات إضافية)'}

المحادثة:
${transcript || conversation.snippet || '(لا توجد رسائل)'}

أرجع JSON فقط بالمفاتيح التالية:
{
  "intent": "greeting|faq|product_info|pricing|lead|complaint|support|cancellation|legal|human_request|other",
  "lead_score": 0,
  "priority": "low|normal|high|urgent",
  "summary": "ملخص دقيق من سطرين",
  "suggested_reply": "رد قصير لا يذكر معلومات غير مؤكدة",
  "next_best_action": "الخطوة التالية العملية",
  "quality_verdict": "pass|review|fail",
  "quality_reasons": ["سبب أو أكثر"],
  "safe_to_auto_reply": false,
  "automation_reason": "سبب مختصر يشرح لماذا الرد آمن أو يحتاج إنسان"
}
قواعد الجودة والأتمتة:
- اجعل quality_verdict=review إذا كان الرد يحتاج معلومة غير موجودة أو تحققًا بشريًا.
- اجعل quality_verdict=fail إذا خالف الرد الممنوعات أو احتوى ادعاءً غير مدعوم.
- safe_to_auto_reply=true فقط للرسائل البسيطة منخفضة المخاطر التي يمكن الرد عليها بالكامل من المحادثة وسياق النشاط المسموح.
- safe_to_auto_reply=false لأي pricing غير مثبت بوضوح، شكوى، دعم يحتاج تشخيص، إلغاء/استرجاع، موضوع قانوني، طلب موظف بشري، بيانات دفع/بطاقات/OTP/كلمات مرور، أو أي حالة فيها نقص معلومات.
- لا تدّع أن الرد تم إرساله.
- suggested_reply يجب أن يلتزم بالأسلوب واللغة والهدف والسياق والحد التقريبي للطول أعلاه.
- lead_score تقدير احتمالي من نص المحادثة فقط.`;

  const gatewayResponse = await fetch(`${supabaseUrl}/functions/v1/ai-gateway`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}`, ...(anonKey ? { apikey: anonKey } : {}) },
    body: JSON.stringify({
      intent: 'general_advice',
      workspaceId: conversation.workspace_id,
      onBehalfOfUserId: userId,
      message: prompt,
      context: {
        source: 'inbox_ai',
        conversation_id: conversation.id,
        platform: conversation.platform,
        transcript,
        inbox_ai_settings: {
          tone: inboxSettings.tone ?? 'professional',
          language: inboxSettings.language ?? 'ar',
          max_reply_length: maxReplyLength,
        },
      },
    }),
  });
  const gatewayBody = await gatewayResponse.json().catch(() => ({})) as Record<string, unknown>;
  if (!gatewayResponse.ok) return jsonResponse({ error: String(gatewayBody.error ?? 'AI Gateway failed') }, 502);

  const result = (gatewayBody.result ?? {}) as Record<string, unknown>;
  const parsed = parseModelJson(result.advice ?? result);
  const qualityReasons = Array.isArray(parsed.quality_reasons) ? parsed.quality_reasons.filter((item): item is string => typeof item === 'string') : ['يجب مراجعة الرد قبل الإرسال'];
  const parsedPriority = priority(parsed.priority);
  const qualityVerdict = verdict(parsed.quality_verdict);
  const safeToAutoReply = parsed.safe_to_auto_reply === true
    && qualityVerdict === 'pass'
    && (parsedPriority === 'low' || parsedPriority === 'normal');
  const analysis = {
    workspace_id: conversation.workspace_id,
    conversation_id: conversation.id,
    intent: text(parsed.intent, 'other'),
    lead_score: score(parsed.lead_score),
    priority: parsedPriority,
    summary: text(parsed.summary, 'لم يتمكن التحليل من إنشاء ملخص موثوق.'),
    suggested_reply: text(parsed.suggested_reply) || null,
    next_best_action: text(parsed.next_best_action, 'مراجعة المحادثة يدويًا.'),
    quality_verdict: qualityVerdict,
    quality_reasons: qualityReasons,
    safe_to_auto_reply: safeToAutoReply,
    automation_reason: text(parsed.automation_reason, safeToAutoReply ? 'اجتاز قواعد الأتمتة الآمنة.' : 'يحتاج مراجعة بشرية.'),
    reply_status: 'pending',
    approved_reply: null,
    approved_by: null,
    approved_at: null,
    rejection_reason: null,
    automated_at: null,
    source_message_ids: orderedMessages.map((message) => message.id),
    provider: typeof gatewayBody.provider === 'string' ? gatewayBody.provider : null,
    model: typeof gatewayBody.model === 'string' ? gatewayBody.model : null,
    created_by: userId,
    updated_at: new Date().toISOString(),
  };

  const { data: saved, error: saveError } = await supabase
    .from('inbox_ai_analyses')
    .upsert(analysis, { onConflict: 'workspace_id,conversation_id' })
    .select('*')
    .single();
  if (saveError) return jsonResponse({ error: saveError.message }, 500);

  await supabase.from('inbox_conversations').update({ needs_review: true }).eq('id', conversation.id).eq('workspace_id', conversation.workspace_id);
  return jsonResponse({ ok: true, analysis: saved });
});
