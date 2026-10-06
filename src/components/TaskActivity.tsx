import { useEffect, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import type { DurableTask } from '@/lib/tasks';


// Poll on mount and while visible: status/results restore even when realtime
// disconnected while the app was closed. The worker never depends on this UI.
export function TaskActivity({ workspaceId, onChange, onTasks }: { workspaceId?: string; onChange: (contentId: string) => Promise<void>; onTasks: (tasks: DurableTask[]) => void }) {
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
  // Keep result restoration and content refresh in the background. Progress
  // controls remain available in TaskMonitor without taking up the content page.
  return null;
}
