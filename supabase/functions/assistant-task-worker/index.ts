import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

type AssistantTask = {
  id: string;
  workspace_id: string;
  user_id: string;
  request_text: string;
  legacy_context: Record<string, unknown>;
  attempt_count: number;
  max_attempts: number;
};

type AgentToolResult = {
  name: string;
  ok: boolean;
  output?: Record<string, unknown>;
  error?: string;
};

type AgentTurn = {
  reply?: string;
  toolResults?: AgentToolResult[];
  clarifyingQuestion?: string;
  pendingApproval?: { reason?: string };
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function completeTask(
  taskId: string,
  resultType: 'content' | 'plan' | 'advice' | 'clarification',
  result: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.from('assistant_tasks').update({
    status: 'completed',
    result_type: resultType,
    result,
    error: null,
    locked_at: null,
    worker_id: null,
    completed_at: new Date().toISOString(),
  }).eq('id', taskId);
  if (error) throw error;
}

async function releaseFailure(task: AssistantTask, message: string): Promise<void> {
  const exhausted = Number(task.attempt_count ?? 0) >= Number(task.max_attempts ?? 3);
  const { error } = await supabase.from('assistant_tasks').update({
    status: exhausted ? 'failed' : 'queued',
    error: message.slice(0, 1000),
    locked_at: null,
    worker_id: null,
    ...(exhausted ? { completed_at: new Date().toISOString() } : {}),
  }).eq('id', task.id);
  if (error) console.error('assistant-task-worker release failed', task.id, error.message);
}

async function callAgent(task: AssistantTask): Promise<AgentTurn> {
  const context = (task.legacy_context ?? {}) as Record<string, unknown>;
  const platforms = Array.isArray(context.platforms)
    ? context.platforms.filter((value): value is string => typeof value === 'string')
    : [];

  const { data: recentInsights } = await supabase
    .from('post_insights')
    .select('metric,value,platform,timestamp')
    .eq('workspace_id', task.workspace_id)
    .order('timestamp', { ascending: false })
    .limit(200);

  const performance = (recentInsights ?? []).reduce<Record<string, number>>((summary, row) => {
    const key = `${row.platform}:${row.metric}`;
    summary[key] = (summary[key] ?? 0) + Number(row.value ?? 0);
    return summary;
  }, {});

  const response = await fetch(`${supabaseUrl}/functions/v1/ai-gateway`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      intent: 'agent',
      workspaceId: task.workspace_id,
      message: task.request_text,
      platforms: platforms.length > 0 ? platforms : undefined,
      onBehalfOfUserId: task.user_id,
      agentMode: true,
      agentContext: { currentRoute: 'create' },
      legacyContext: { ...context, performance },
    }),
  });

  const body = await response.json().catch(() => ({})) as AgentTurn & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `AI Gateway failed (${response.status})`);
  return body;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!serviceRoleKey || token !== serviceRoleKey) {
    return json(401, { error: 'Unauthorized internal worker call' });
  }

  const body = await req.json().catch(() => ({})) as { taskId?: string };
  const workerId = `assistant-worker-${crypto.randomUUID()}`;
  const { data: claimed, error: claimError } = await supabase.rpc('claim_assistant_task', {
    p_worker_id: workerId,
    p_task_id: body.taskId?.trim() || null,
  });
  if (claimError) return json(500, { error: claimError.message });

  const task = (Array.isArray(claimed) ? claimed[0] : claimed) as AssistantTask | null;
  if (!task) return json(200, { processed: false, reason: 'queue_empty' });

  try {
    const turn = await callAgent(task);

    if (turn.clarifyingQuestion) {
      await completeTask(task.id, 'clarification', { text: turn.clarifyingQuestion });
      return json(200, { processed: true, taskId: task.id, resultType: 'clarification' });
    }

    if (turn.pendingApproval) {
      await completeTask(task.id, 'clarification', {
        text: turn.reply?.trim()
          || turn.pendingApproval.reason?.trim()
          || 'الطلب يحتاج موافقتك قبل تنفيذ خطوة خارجية.',
      });
      return json(200, { processed: true, taskId: task.id, resultType: 'clarification', requiresApproval: true });
    }

    const succeeded = (turn.toolResults ?? []).find((result) => result.ok && result.output);
    if (!succeeded?.output) {
      const failed = (turn.toolResults ?? []).find((result) => result.error);
      if (turn.reply?.trim()) {
        await completeTask(task.id, 'advice', { advice: turn.reply.trim() });
        return json(200, { processed: true, taskId: task.id, resultType: 'advice' });
      }
      throw new Error(failed?.error ?? 'الـAI لم يُرجع نتيجة قابلة للاستخدام');
    }

    if (succeeded.name === 'create_content') {
      await completeTask(task.id, 'content', succeeded.output);
      return json(200, { processed: true, taskId: task.id, resultType: 'content' });
    }
    if (succeeded.name === 'create_content_plan') {
      await completeTask(task.id, 'plan', succeeded.output);
      return json(200, { processed: true, taskId: task.id, resultType: 'plan' });
    }

    const advice = typeof succeeded.output.advice === 'string'
      ? succeeded.output.advice
      : turn.reply?.trim() || 'تم تنفيذ التحليل.';
    await completeTask(task.id, 'advice', { ...succeeded.output, advice });
    return json(200, { processed: true, taskId: task.id, resultType: 'advice' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('assistant-task-worker failed', task.id, message);
    await releaseFailure(task, message);
    return json(500, {
      processed: false,
      taskId: task.id,
      retryQueued: task.attempt_count < task.max_attempts,
      error: message,
    });
  }
});
