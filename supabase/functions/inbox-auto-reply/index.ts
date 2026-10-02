import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type InboxAiSettings = {
  enabled?: boolean;
  replyMode?: 'draft' | 'auto_safe';
  autoReplyMaxPerHour?: number;
  autoReplyDelaySeconds?: number;
  maxReplyLength?: number;
};

type Analysis = {
  id: string;
  intent: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  suggested_reply: string | null;
  quality_verdict: 'pass' | 'review' | 'fail';
  safe_to_auto_reply: boolean;
  automation_reason: string | null;
  source_message_ids: string[];
};

type RunRow = {
  id: string;
  status: 'processing' | 'sent' | 'skipped' | 'failed';
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function reasonText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
}

function riskyText(value: string): boolean {
  const normalized = value.toLowerCase();
  const risky = [
    /\b(?:password|otp|cvv|pin)\b/i,
    /\b(?:credit card|debit card|bank account|iban)\b/i,
    /\b(?:refund|cancel|cancellation|complaint|legal|lawyer|lawsuit)\b/i,
    /\b(?:human|agent|representative|supervisor)\b/i,
    /كلمة\s*سر|رمز\s*(?:تحقق|تأكيد)|بطاق(?:ة|ه)|رقم\s*حساب|تحويل\s*بنكي/,
    /شكوى|استرجاع|استرداد|إلغاء|محامي|قانون|موظف|ممثل\s*خدمة|مشرف|إنسان/,
  ];
  return risky.some((pattern) => pattern.test(normalized));
}

async function updateRun(id: string, values: Record<string, unknown>): Promise<void> {
  await supabase.from('inbox_auto_reply_runs').update(values).eq('id', id);
}

async function skip(runId: string, reason: string, conversationId?: string): Promise<Response> {
  await updateRun(runId, { status: 'skipped', reason });
  if (conversationId) {
    await supabase.from('inbox_conversations').update({ needs_review: true }).eq('id', conversationId);
  }
  return json(200, { ok: true, sent: false, status: 'skipped', reason });
}

async function postInternal(path: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${supabaseUrl}/functions/v1/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof body.error === 'string' ? body.error : `${path} failed with HTTP ${response.status}`);
  }
  return body;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!serviceRoleKey || token !== serviceRoleKey) {
    return json(401, { error: 'Unauthorized internal call' });
  }

  const body = await req.json().catch(() => ({})) as { inboundMessageId?: string };
  const inboundMessageId = body.inboundMessageId?.trim();
  if (!inboundMessageId) return json(400, { error: 'inboundMessageId is required' });

  const { data: inbound } = await supabase
    .from('inbox_messages')
    .select('id,workspace_id,conversation_id,direction,content,metadata,created_at')
    .eq('id', inboundMessageId)
    .maybeSingle();
  if (!inbound || inbound.direction !== 'inbound') {
    return json(404, { error: 'Inbound message not found' });
  }

  const { data: claimed, error: claimError } = await supabase
    .from('inbox_auto_reply_runs')
    .insert({
      workspace_id: inbound.workspace_id,
      conversation_id: inbound.conversation_id,
      inbound_message_id: inbound.id,
      status: 'processing',
    })
    .select('id,status')
    .single();

  if (claimError) {
    if (claimError.code === '23505') {
      const { data: existing } = await supabase
        .from('inbox_auto_reply_runs')
        .select('id,status,reason')
        .eq('inbound_message_id', inbound.id)
        .maybeSingle();
      return json(200, {
        ok: true,
        sent: existing?.status === 'sent',
        status: existing?.status ?? 'already_claimed',
        reason: existing?.reason ?? 'idempotency_guard',
      });
    }
    return json(500, { error: claimError.message });
  }

  const run = claimed as RunRow;

  try {
    const [{ data: conversation }, { data: workspace }] = await Promise.all([
      supabase.from('inbox_conversations')
        .select('id,workspace_id,account_id,platform,type,status,metadata')
        .eq('id', inbound.conversation_id)
        .maybeSingle(),
      supabase.from('workspaces')
        .select('owner_id,settings')
        .eq('id', inbound.workspace_id)
        .maybeSingle(),
    ]);

    if (!conversation || !workspace) return skip(run.id, 'conversation_or_workspace_missing');

    const settingsRoot = (workspace.settings ?? {}) as Record<string, unknown>;
    const settings = (settingsRoot.inbox_ai ?? {}) as InboxAiSettings;
    if (settings.enabled === false || settings.replyMode !== 'auto_safe') {
      return skip(run.id, 'auto_safe_disabled');
    }

    if (
      conversation.platform !== 'whatsapp'
      || conversation.type !== 'dm'
      || conversation.status !== 'open'
      || conversation.metadata?.provider !== 'evolution'
      || conversation.metadata?.is_group === true
    ) {
      return skip(run.id, 'unsupported_conversation_for_auto_safe', conversation.id);
    }

    const messageType = typeof inbound.metadata?.message_type === 'string' ? inbound.metadata.message_type : 'text';
    if (messageType !== 'text') {
      return skip(run.id, 'non_text_message_requires_human', conversation.id);
    }

    const content = String(inbound.content ?? '').trim();
    if (!content || content.length > 4000 || riskyText(content)) {
      return skip(run.id, 'deterministic_safety_filter', conversation.id);
    }

    const ownerId = typeof workspace.owner_id === 'string' ? workspace.owner_id : '';
    let actingUserId = ownerId;
    let membership = null as { user_id: string } | null;
    if (ownerId) {
      const result = await supabase.from('workspace_members')
        .select('user_id')
        .eq('workspace_id', inbound.workspace_id)
        .eq('user_id', ownerId)
        .maybeSingle();
      membership = result.data;
    }
    if (!membership) {
      const result = await supabase.from('workspace_members')
        .select('user_id')
        .eq('workspace_id', inbound.workspace_id)
        .in('role', ['owner', 'admin'])
        .limit(1)
        .maybeSingle();
      membership = result.data;
      actingUserId = membership?.user_id ?? '';
    }
    if (!actingUserId) return skip(run.id, 'no_workspace_operator', conversation.id);

    const maxPerHour = Math.max(1, Math.min(10, Math.round(Number(settings.autoReplyMaxPerHour ?? 3))));
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const [{ count: conversationSent }, { count: workspaceSent }] = await Promise.all([
      supabase.from('inbox_auto_reply_runs')
        .select('id', { head: true, count: 'exact' })
        .eq('conversation_id', conversation.id)
        .eq('status', 'sent')
        .gte('created_at', hourAgo),
      supabase.from('inbox_auto_reply_runs')
        .select('id', { head: true, count: 'exact' })
        .eq('workspace_id', inbound.workspace_id)
        .eq('status', 'sent')
        .gte('created_at', hourAgo),
    ]);

    if ((conversationSent ?? 0) >= maxPerHour) {
      return skip(run.id, 'conversation_hourly_rate_limit', conversation.id);
    }
    if ((workspaceSent ?? 0) >= 50) {
      return skip(run.id, 'workspace_hourly_rate_limit', conversation.id);
    }

    const delaySeconds = Math.max(0, Math.min(15, Math.round(Number(settings.autoReplyDelaySeconds ?? 4))));
    if (delaySeconds > 0) {
      await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
    }

    const { data: latestBeforeAnalysis } = await supabase.from('inbox_messages')
      .select('id')
      .eq('conversation_id', conversation.id)
      .eq('direction', 'inbound')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestBeforeAnalysis?.id !== inbound.id) {
      return skip(run.id, 'superseded_during_aggregation_delay', conversation.id);
    }

    const analysisResponse = await postInternal('inbox-ai', {
      conversationId: conversation.id,
      action: 'analyze',
      onBehalfOfUserId: actingUserId,
    });
    const analysis = analysisResponse.analysis as Analysis | undefined;
    if (!analysis?.id) throw new Error('AI analysis missing');

    await updateRun(run.id, { analysis_id: analysis.id });

    const allowedIntents = new Set(['greeting', 'faq', 'product_info']);
    if (
      analysis.quality_verdict !== 'pass'
      || analysis.safe_to_auto_reply !== true
      || !allowedIntents.has(analysis.intent)
      || !['low', 'normal'].includes(analysis.priority)
      || !analysis.suggested_reply?.trim()
    ) {
      return skip(
        run.id,
        `ai_gate:${analysis.intent}:${analysis.quality_verdict}:${analysis.automation_reason ?? 'review'}`,
        conversation.id,
      );
    }

    const maxReplyLength = Math.max(80, Math.min(1000, Math.round(Number(settings.maxReplyLength ?? 320))));
    const reply = analysis.suggested_reply.trim();
    if (reply.length > maxReplyLength + 80 || riskyText(reply)) {
      return skip(run.id, 'generated_reply_failed_deterministic_gate', conversation.id);
    }

    // Avoid replying to a stale message if the customer sent something newer
    // while the model was working.
    const { data: latestInbound } = await supabase.from('inbox_messages')
      .select('id,created_at')
      .eq('conversation_id', conversation.id)
      .eq('direction', 'inbound')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latestInbound?.id !== inbound.id) {
      return skip(run.id, 'superseded_by_newer_inbound', conversation.id);
    }

    // If a human or another automation replied after this inbound message,
    // never send another automatic response.
    const { data: newerOutbound } = await supabase.from('inbox_messages')
      .select('id')
      .eq('conversation_id', conversation.id)
      .eq('direction', 'outbound')
      .gt('created_at', inbound.created_at)
      .limit(1)
      .maybeSingle();
    if (newerOutbound) {
      return skip(run.id, 'outbound_already_exists_after_inbound', conversation.id);
    }

    const sendResponse = await postInternal('inbox-reply', {
      conversationId: conversation.id,
      content: reply,
      onBehalfOfUserId: actingUserId,
      isAi: true,
      aiAnalysisId: analysis.id,
      autoReplyRunId: run.id,
    });
    const outbound = sendResponse.message as { id?: string } | undefined;
    if (!outbound?.id) {
      throw new Error('Outbound message was sent without an audit row');
    }

    await Promise.all([
      updateRun(run.id, {
        status: 'sent',
        reason: analysis.automation_reason ?? 'safe_auto_reply',
        outbound_message_id: outbound.id,
      }),
      supabase.from('inbox_ai_analyses').update({
        reply_status: 'auto_sent',
        approved_reply: reply,
        approved_by: null,
        approved_at: null,
        automated_at: new Date().toISOString(),
      }).eq('id', analysis.id),
      supabase.from('inbox_conversations').update({
        needs_review: false,
        unread: false,
      }).eq('id', conversation.id),
    ]);

    return json(200, {
      ok: true,
      sent: true,
      runId: run.id,
      analysisId: analysis.id,
      outboundMessageId: outbound.id,
    });
  } catch (error) {
    const reason = reasonText(error);
    await updateRun(run.id, { status: 'failed', reason });
    await supabase.from('inbox_conversations').update({ needs_review: true }).eq('id', inbound.conversation_id);
    await supabase.from('notifications').insert({
      workspace_id: inbound.workspace_id,
      type: 'inbox_auto_reply_failed',
      title: 'تعذّر رد AI التلقائي',
      body: reason,
      payload: {
        conversation_id: inbound.conversation_id,
        inbound_message_id: inbound.id,
        auto_reply_run_id: run.id,
      },
    });
    return json(500, { error: reason, runId: run.id });
  }
});
