import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { TaskProgress } from './TaskProgress';
import type { DurableTask } from '@/lib/tasks';


// Poll on mount and while visible: status/results restore even when realtime
// disconnected while the app was closed. The worker never depends on this UI.
export function TaskActivity({ workspaceId, onChange, onTasks }: { workspaceId?: string; onChange: (contentId: string) => Promise<void>; onTasks: (tasks: DurableTask[]) => void }) {
  const [tasks, setTasks] = useState<DurableTask[]>([]);
  const refresh = useRef(onChange);
  const restore = useRef(onTasks);
  const previous = useRef('');
  useEffect(() => { refresh.current = onChange; restore.current = onTasks; }, [onChange, onTasks]);
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    const load = async () => {
      const { data, error } = await supabase.from('assistant_tasks').select('*').eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(20);
      if (cancelled || error || !data) return;
      setTasks(data as DurableTask[]);
      const signature = JSON.stringify(data.map(t => [t.id,t.status,t.updated_at]));
      if (signature !== previous.current) {
        previous.current = signature;
        restore.current(data as DurableTask[]);
        const contentIds = new Set(data.map(t => (t.payload?.agentContext as { currentContentId?: string } | undefined)?.currentContentId).filter(Boolean));
        // Refresh the list/calendar even for publish/rpc tasks without context.
        for (const id of contentIds.size ? contentIds : ['']) await refresh.current(id as string);
      }
    };
    void load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 5000);
    const focused = () => { void load(); };
    window.addEventListener('focus', focused);
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener('focus', focused); };
  }, [workspaceId]);
  if (!tasks.length) return null;
  return <section className="mb-4 rounded-xl border border-ink-800 p-4" aria-live="polite">
    <p className="text-sm text-ink-300 mb-2">المهام المحفوظة — تكمل حتى لو قفلت التطبيق</p>
    <div className="space-y-3">{[...tasks.filter(task => task.status === 'running' || task.status === 'queued'), ...tasks.filter(task => task.status !== 'running' && task.status !== 'queued').slice(0, 3)].map(task => <TaskProgress key={task.id} task={task} onUpdate={next => {
      const updated = [next, ...tasks.filter(item => item.id !== next.id).map(item => item.id === task.id && next.id !== task.id && (item.status === 'running' || item.status === 'queued') ? { ...item, status: 'cancelled' as const } : item)];
      setTasks(updated);
      restore.current(updated);
      void refresh.current((next.payload.agentContext as { currentContentId?: string } | undefined)?.currentContentId ?? '');
    }} />)}</div>
  </section>;
}
