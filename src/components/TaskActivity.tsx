import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/lib/supabase';
import type { DurableTask } from '@/lib/tasks';

const labels = { queued: 'في الانتظار', running: 'جارٍ التنفيذ على السيرفر', completed: 'اكتملت', failed: 'تحتاج مراجعة' };

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
    {tasks.slice(0, 5).map(task => <div key={task.id} className="text-sm mb-2">
      <span className={task.status === 'failed' ? 'text-danger-300' : 'text-brand-300'}>{labels[task.status]}</span>
      <span className="text-ink-400"> · {task.request_text.slice(0, 90)}</span>
      {task.error && <p className="text-danger-300">{task.error}</p>}
      {Boolean(task.result?.pendingApproval) && <p className="text-warning-300">تنتظر موافقتك؛ افتح المنشور وراجع الإجراء المقترح.</p>}
    </div>)}
  </section>;
}
