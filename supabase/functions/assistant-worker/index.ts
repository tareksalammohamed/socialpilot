import { executeBrandMemoryTool, BRAND_MEMORY_TOOLS } from '../ai-gateway/agent/executors-brand.ts';
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import { executePublishingTool, PUBLISHING_TOOLS, type UserScope } from '../ai-gateway/agent/executors-publishing.ts';
import type { AgentContext, ToolCall } from '../ai-gateway/agent/types.ts';

const url = Deno.env.get('SUPABASE_URL') ?? '';
const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const db = createClient(url, key, { auth: { persistSession: false } });
type Task = { id: string; workspace_id: string; user_id: string; task_kind: string; payload: Record<string, unknown>; checkpoint: Record<string, unknown> | null; attempt_count: number; max_attempts: number };

async function call(path: string, body: unknown, task?: Task, worker?: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${url}/functions/v1/${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}`, apikey: key,
      ...(task ? { 'X-Assistant-Task': task.id, 'X-Assistant-Worker': worker! } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(120_000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Request failed (${response.status})`);
  return result;
}

async function execute(task: Task, worker: string): Promise<void> {
  try {
    const { data: member } = await db.from('workspace_members').select('role').eq('workspace_id', task.workspace_id).eq('user_id', task.user_id).maybeSingle();
    if (!member) throw new Error('workspace_access_denied');
    if (['create','agent'].includes(task.task_kind)) {
      const legacy = (task.payload.legacyContext ?? {}) as Record<string, unknown>;
      if (!Object.hasOwn(legacy, 'performance')) {
        const { data: insights, error } = await db.from('post_insights').select('metric,value,platform').eq('workspace_id', task.workspace_id).order('timestamp', { ascending:false }).limit(200);
        if (error) throw error;
        const performance: Record<string, number> = {};
        for (const row of insights ?? []) { const k = `${row.platform}:${row.metric}`; performance[k] = (performance[k] ?? 0) + Number(row.value ?? 0); }
        task.payload = { ...task.payload, legacyContext: { ...legacy, performance } };
        const { data: saved, error: saveError } = await db.from('assistant_tasks').update({ payload: task.payload }).eq('id',task.id).eq('worker_id',worker).eq('status','running').select('id').maybeSingle();
        if (saveError || !saved) throw new Error('lease_lost');
      }
    }
    const rpc = (name: string, args: Record<string, unknown>) => db.rpc('run_assistant_task_rpc', { p_task_id: task.id, p_worker_id: worker, p_rpc: name, p_args: { ...args, p_workspace_id: task.workspace_id } });
    let turn = task.checkpoint;
    if (!turn) {
      if (task.task_kind === 'rpc') {
        const { data, error } = await rpc(String(task.payload.rpc), task.payload.args as Record<string, unknown>);
        if (error) throw error;
        turn = { ...data, advice: 'تم تنفيذ الإجراء.' };
      } else if (task.task_kind === 'publish') {
        turn = await call('social-publish', { ...task.payload, workspaceId: task.workspace_id }, task, worker);
      } else if (task.task_kind === 'approved') {
        const scope: UserScope = { token: key, supabaseUrl: url, anonKey: key, taskId: task.id, workerId: worker,
          client: { rpc } as unknown as UserScope['client'] };
        const context = { ...(task.payload.agentContext as object ?? {}), workspaceId: task.workspace_id, userId: task.user_id } as AgentContext;
        const toolResults = [];
        for (const c of task.payload.toolCalls as ToolCall[]) {
          if (PUBLISHING_TOOLS.has(c.name)) toolResults.push(await executePublishingTool(c, context, db, scope));
          else if (BRAND_MEMORY_TOOLS.has(c.name)) toolResults.push(await executeBrandMemoryTool(c, context, db));
          else throw new Error(`Unsupported approved tool: ${c.name}`);
        }
        turn = { toolResults };
      } else {
        turn = await call('ai-gateway', { ...task.payload, workspaceId: task.workspace_id, onBehalfOfUserId: task.user_id, agentMode: true }, task, worker);
        const results = turn.toolResults as { ok: boolean; error?: string }[] | undefined;
        if (!turn.clarifyingQuestion && !turn.pendingApproval && !results?.some(r => r.ok)) throw new Error(results?.find(r => r.error)?.error ?? 'agent_execution_failed');
      }
      const { data: saved, error } = await db.from('assistant_tasks').update({ checkpoint: turn }).eq('id', task.id).eq('worker_id', worker).eq('status', 'running').select('id').maybeSingle();
      if (error || !saved) throw new Error('lease_lost');
    }
    const { error } = await db.rpc('complete_assistant_task', { p_task_id: task.id, p_worker_id: worker, p_turn: turn });
    if (error) throw error;
  } catch (error) {
    const message = error instanceof Error ? error.message : String((error as { message?: string }).message ?? error);
    console.error('assistant-worker', task.id, message);
    // Publishing can have succeeded remotely before a timeout. Never replay an
    // ambiguous immediate publish automatically; its durable publish job is the
    // source of truth and is visible for review.
    const yielded = message.includes('background_checkpoint');
    const retry = yielded || (!['publish', 'approved'].includes(task.task_kind) && task.attempt_count < task.max_attempts && !message.includes('workspace_access_denied'));
    await db.from('assistant_tasks').update({ status: retry ? 'queued' : 'failed', error: yielded ? null : message, ...(yielded ? { attempt_count: task.attempt_count - 1 } : {}), locked_at: null, worker_id: null,
      available_at: new Date(Date.now() + task.attempt_count * 60_000).toISOString() }).eq('id', task.id).eq('worker_id', worker).eq('status', 'running');
  }
}

export async function drain(): Promise<void> {
  const worker = crypto.randomUUID();
  // Independent requests can race safely: claim uses FOR UPDATE SKIP LOCKED.
  const tasks: Task[] = [];
  for (let i = 0; i < 3; i++) {
    const { data, error } = await db.rpc('claim_assistant_task', { p_worker_id: worker });
    if (error) throw error;
    if (data?.[0]) tasks.push(data[0]); else break;
  }
  await Promise.all(tasks.map(task => execute(task, worker)));
}

Deno.serve(async req => {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: cronSecret } = await db.rpc('get_scheduler_cron_secret');
  if (!token || (token !== key && token !== cronSecret)) return new Response('Unauthorized', { status: 401 });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const work = drain().catch(error => console.error('assistant-worker drain failed', error));
  // Respond before pg_net times out; cron will recover persisted leases if this
  // isolate exits, rather than relying on the lifetime of this one invocation.
  (globalThis as unknown as { EdgeRuntime: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime.waitUntil(work);
  return Response.json({ accepted: true }, { status: 202 });
});
