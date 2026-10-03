import { supabase } from './supabase';

export type DurableTask = {
  id: string; workspace_id: string; user_id: string; task_kind: string;
  status: 'queued' | 'running' | 'completed' | 'failed'; request_text: string;
  payload: Record<string, unknown>; result: Record<string, unknown> | null;
  error: string | null; created_at: string;
};

export async function enqueueTask(workspaceId: string, kind: string, payload: Record<string, unknown>): Promise<string> {
  const { data, error } = await supabase.rpc('enqueue_assistant_task', {
    p_workspace_id: workspaceId, p_kind: kind, p_payload: payload, p_request_id: crypto.randomUUID(),
  });
  if (error) throw error;
  return data as string;
}

// Waiting here only updates the visible screen. Closing it does not cancel the
// persisted job, and no result or business state is written by this waiter.
export async function waitForTask<T>(id: string): Promise<T> {
  for (;;) {
    const { data, error } = await supabase.from('assistant_tasks').select('status,result,error').eq('id', id).single();
    if (error) throw error;
    if (data.status === 'completed') return data.result as T;
    if (data.status === 'failed') throw new Error(data.error ?? 'فشل تنفيذ المهمة');
    await new Promise(resolve => setTimeout(resolve, 2500));
  }
}

export async function durableRpc(workspaceId: string, rpc: string, args: Record<string, unknown>) {
  const labels: Record<string, string> = { approve_content_variant: 'اعتماد المنشور وجدولته', reschedule_calendar_item: 'تعديل موعد النشر', cancel_calendar_item: 'إلغاء الجدولة' };
  return waitForTask(await enqueueTask(workspaceId, 'rpc', { rpc, args, message: labels[rpc] ?? 'تنفيذ الإجراء' }));
}
