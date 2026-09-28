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

type Body = { conversationId?: string };
type Message = { id: string; direction: 'inbound' | 'outbound'; content: string; sender_name: string | null; created_at: string };
type ParsedAnalysis = {
  intent?: unknown;
  lead_score?: unknown;
  priority?: unknown;
  summary?: unknown;
  suggested_reply?: unknown;
  next_best_action?: unknown;
  quality_verdict?: unknown;
  quality_reasons?: unknown;
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

  const authHeader = req.headers.get('Authorization') ?? '';
  const userToken = authHeader.replace(/^Bearer\s+/i, '');
  if (!userToken) return jsonResponse({ error: 'Missing authentication token' }, 401);
  const { data: userData, error: userError } = await supabase.auth.getUser(userToken);
  if (userError || !userData.user) return jsonResponse({ error: 'Invalid or expired token' }, 401);

  let body: Body;
  try { body = await req.json() as Body; } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }
  if (!body.conversationId) return jsonResponse({ error: 'conversationId is required' }, 400);

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
    .eq('user_id', userData.user.id)
    .maybeSingle();
  if (!membership) return jsonResponse({ error: 'Forbidden' }, 403);

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
  const prompt = `حلل محادثة مبيعات حقيقية من صندوق الرسائل الموحد. لا تخترع أي معلومة غير موجودة في المحادثة أو Brand DNA.
المنصة: ${conversation.platform}
النوع: ${conversation.type}
الاسم: ${conversation.sender_name ?? 'غير معروف'}
المحادثة:
${transcript || conversation.snippet || '(لا توجد رسائل)'}

أرجع JSON فقط بالمفاتيح التالية:
{
  "intent": "سؤال|طلب سعر|شكوى|اهتمام|متابعة|غير محدد",
  "lead_score": 0,
  "priority": "low|normal|high|urgent",
  "summary": "ملخص دقيق من سطرين",
  "suggested_reply": "رد عربي قصير لا يذكر معلومات غير مؤكدة",
  "next_best_action": "الخطوة التالية العملية",
  "quality_verdict": "pass|review|fail",
  "quality_reasons": ["سبب أو أكثر"]
}
قواعد الجودة: اجعل quality_verdict=review إذا كان الرد يحتاج معلومة من الشركة أو موافقة بشرية، ولا تقترح إرسالًا تلقائيًا. lead_score تقدير احتمالي من نص المحادثة فقط.`;

  const gatewayResponse = await fetch(`${supabaseUrl}/functions/v1/ai-gateway`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}`, ...(anonKey ? { apikey: anonKey } : {}) },
    body: JSON.stringify({
      intent: 'general_advice',
      workspaceId: conversation.workspace_id,
      onBehalfOfUserId: userData.user.id,
      message: prompt,
      context: { source: 'inbox_ai', conversation_id: conversation.id, platform: conversation.platform, transcript },
    }),
  });
  const gatewayBody = await gatewayResponse.json().catch(() => ({})) as Record<string, unknown>;
  if (!gatewayResponse.ok) return jsonResponse({ error: String(gatewayBody.error ?? 'AI Gateway failed') }, 502);

  const result = (gatewayBody.result ?? {}) as Record<string, unknown>;
  const parsed = parseModelJson(result.advice ?? result);
  const qualityReasons = Array.isArray(parsed.quality_reasons) ? parsed.quality_reasons.filter((item): item is string => typeof item === 'string') : ['يجب مراجعة الرد قبل الإرسال'];
  const analysis = {
    workspace_id: conversation.workspace_id,
    conversation_id: conversation.id,
    intent: text(parsed.intent, 'غير محدد'),
    lead_score: score(parsed.lead_score),
    priority: priority(parsed.priority),
    summary: text(parsed.summary, 'لم يتمكن التحليل من إنشاء ملخص موثوق.'),
    suggested_reply: text(parsed.suggested_reply) || null,
    next_best_action: text(parsed.next_best_action, 'مراجعة المحادثة يدويًا.'),
    quality_verdict: verdict(parsed.quality_verdict),
    quality_reasons: qualityReasons,
    source_message_ids: orderedMessages.map((message) => message.id),
    provider: typeof gatewayBody.provider === 'string' ? gatewayBody.provider : null,
    model: typeof gatewayBody.model === 'string' ? gatewayBody.model : null,
    created_by: userData.user.id,
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
