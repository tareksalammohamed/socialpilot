import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Activity } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import type { DurableTask } from '@/lib/tasks';
import { TaskProgress } from './TaskProgress';

/** Lives above routed screens. Polling/focus restores actual persisted progress
 * even if realtime disconnected while the browser was closed. */
export function TaskMonitor() {
  const { workspace, user } = useAuth();
  const workspaceId = workspace?.id;
  const userId = user?.id;
  const [tasks, setTasks] = useState<DurableTask[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    setTasks([]);
    if (!workspaceId || !userId) return;
    let disposed = false;
    let loading = false;
    async function load() {
      if (loading || disposed) return;
      loading = true;
      const base = () => supabase.from('assistant_tasks').select('*').eq('workspace_id', workspaceId).eq('user_id', userId);
      try {
        const [active, latest] = await Promise.all([
          base().in('status', ['queued', 'running']).order('created_at', { ascending: false }),
          base().order('created_at', { ascending: false }).limit(1).maybeSingle(),
        ]);
        if (disposed) return;
        if (active.error || latest.error) { setUnavailable(true); return; }
        setUnavailable(false);
        setTasks((active.data?.length ? active.data : latest.data ? [latest.data] : []) as DurableTask[]);
      } catch { if (!disposed) setUnavailable(true); }
      finally { loading = false; }
    }
    const refresh = () => { void load(); };
    void load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 3000);
    window.addEventListener('focus', refresh);
    window.addEventListener('assistant-task-change', refresh);
    const channel = supabase.channel(`task-monitor:${workspaceId}:${userId}`).on('postgres_changes', {
      event: '*', schema: 'public', table: 'assistant_tasks', filter: `user_id=eq.${userId}`,
    }, refresh).subscribe();
    return () => { disposed = true; clearInterval(timer); window.removeEventListener('focus', refresh); window.removeEventListener('assistant-task-change', refresh); void supabase.removeChannel(channel); };
  }, [workspaceId, userId]);
  if (!tasks.length && !unavailable) return null;
  const active = tasks.filter(task => task.status === 'queued' || task.status === 'running');
  const current = active.find(task => task.status === 'running') ?? tasks[0];
  const title = unavailable ? 'تعذر تحديث حالة المهام؛ آخر بيانات معروضة قديمة' : active.length ? (current.status === 'queued' ? 'المهمة في الانتظار' : current.progress?.label ?? 'جارٍ تجهيز المهمة') : current?.status === 'cancelled' ? 'تم إيقاف آخر طلب' : current?.status === 'failed' ? 'آخر طلب يحتاج مراجعة' : 'اكتمل آخر طلب';
  return <aside className="sticky top-0 z-40 px-3 pt-2 bg-ink-950/95 backdrop-blur" aria-label="متابعة تنفيذ المهام">
    <div className="max-w-5xl mx-auto">
      <button type="button" onClick={() => setExpanded(value => !value)} aria-expanded={expanded} aria-controls="global-task-progress" className="w-full flex items-center gap-3 rounded-xl border border-brand-500/30 bg-ink-900 px-4 py-3 text-right">
        <Activity size={18} className="text-brand-400 shrink-0" />
        <span className="flex-1 min-w-0"><span className="block text-sm text-ink-100 truncate" aria-live="polite">{title}</span><span className="block text-xs text-ink-400 truncate">{current?.request_text ?? 'انتظر عودة الاتصال'}</span></span>
        {active.length > 1 && <span className="text-xs text-brand-300">{active.length} مهام</span>}
        {expanded ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
      </button>
      {expanded && <div id="global-task-progress" className="max-h-[55vh] overflow-y-auto space-y-2 mt-2 pb-2">{tasks.map(task => <TaskProgress key={task.id} task={task} onUpdate={next => {
        setTasks(previous => [next, ...previous.filter(item => item.id !== next.id && item.id !== task.id)]);
      }} />)}</div>}
    </div>
  </aside>;
}
