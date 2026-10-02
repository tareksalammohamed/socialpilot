import { createClient } from 'npm:@supabase/supabase-js@2.57.4';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
};

const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

declare const EdgeRuntime: {
  waitUntil(promise: Promise<unknown>): void;
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: auth } = await supabase.auth.getUser(jwt);
  if (!auth.user) return json(401, { error: 'Unauthorized' });

  const body = await req.json().catch(() => ({})) as { taskId?: string };
  const taskId = body.taskId?.trim();
  if (!taskId) return json(400, { error: 'taskId is required' });

  const { data: task } = await supabase
    .from('assistant_tasks')
    .select('id,workspace_id,user_id,status')
    .eq('id', taskId)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (!task) return json(404, { error: 'المهمة غير موجودة' });

  const { data: membership } = await supabase
    .from('workspace_members')
    .select('id')
    .eq('workspace_id', task.workspace_id)
    .eq('user_id', auth.user.id)
    .maybeSingle();
  if (!membership) return json(403, { error: 'Forbidden' });

  if (task.status === 'completed' || task.status === 'failed') {
    return json(200, { ok: true, taskId, status: task.status, dispatched: false });
  }

  const work = fetch(`${supabaseUrl}/functions/v1/assistant-task-worker`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ taskId }),
  }).then(async (response) => {
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error('assistant-task-dispatch worker failed', response.status, detail.slice(0, 1000));
    }
  }).catch((error) => {
    console.error('assistant-task-dispatch background fetch failed', error);
  });

  EdgeRuntime.waitUntil(work);
  return json(202, { ok: true, taskId, status: task.status, dispatched: true });
});
