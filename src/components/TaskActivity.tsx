import { useEffect, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import type { DurableTask } from '@/lib/tasks';

/** Restore task results without refetching every content list on each progress
 * update. The worker's persisted state remains independent of this screen. */
export function TaskActivity({ workspaceId, onChange, onTasks }: {
  workspaceId?: string;
  onChange: (contentIds: string[]) => Promise<void>;
  onTasks: (tasks: DurableTask[]) => void;
}) {
  const refresh = useRef(onChange);
  const restore = useRef(onTasks);
  useEffect(() => { refresh.current = onChange; restore.current = onTasks; }, [onChange, onTasks]);
  useEffect(() => {
    if (!workspaceId) return;
    let disposed = false, loading = false, initialized = false, active = false, loadedAt = 0;
    let previous = new Map<string, string>();
    let signature = '';
    const load = async () => {
      if (disposed || loading) return;
      loading = true;
      try {
        const { data, error } = await supabase.from('assistant_tasks').select('id,workspace_id,user_id,task_kind,status,request_text,payload,result,error,created_at,updated_at').eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(20);
        if (disposed || error || !data) return;
        loadedAt = Date.now();
        const tasks = data as DurableTask[];
        active = tasks.some(task => task.status === 'running' || task.status === 'queued');
        const nextSignature = JSON.stringify(tasks.map(task => [task.id, task.status, task.updated_at]));
        if (signature === nextSignature) return;
        signature = nextSignature;
        restore.current(tasks);
        const completed = tasks.filter(task => ['completed', 'failed', 'cancelled'].includes(task.status) && previous.get(task.id) !== task.status);
        const shouldRefresh = initialized && completed.length > 0;
        previous = new Map(tasks.map(task => [task.id, task.status]));
        initialized = true;
        if (shouldRefresh) {
          const ids = completed.map(task => (task.payload.agentContext as { currentContentId?: string } | undefined)?.currentContentId).filter((id): id is string => Boolean(id));
          await refresh.current([...new Set(ids)]);
        }
      } catch { /* Keep the last confirmed task state until reconnection. */ }
      finally { loading = false; }
    };
    const focused = () => { if (document.visibilityState === 'visible') void load(); };
    void load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible' && Date.now() - loadedAt >= (active ? 5000 : 60000)) void load(); }, 5000);
    const channel = supabase.channel(`content-task-activity:${workspaceId}`).on('postgres_changes', {
      event: '*', schema: 'public', table: 'assistant_tasks', filter: `workspace_id=eq.${workspaceId}`,
    }, focused).subscribe();
    window.addEventListener('focus', focused);
    document.addEventListener('visibilitychange', focused);
    return () => {
      disposed = true; clearInterval(timer); window.removeEventListener('focus', focused);
      document.removeEventListener('visibilitychange', focused); void supabase.removeChannel(channel);
    };
  }, [workspaceId]);
  return null;
}
