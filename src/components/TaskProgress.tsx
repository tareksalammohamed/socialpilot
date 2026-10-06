import { useEffect, useState } from 'react';
import { CheckCircle2, CircleStop, RotateCcw, Clock3, Activity } from 'lucide-react';
import { Button, ErrorBanner, Spinner } from './ui';
import { cancelTask, restartTask, type DurableTask } from '@/lib/tasks';
import { useAuth } from '@/lib/auth';
import { taskErrorMessage } from '../../supabase/functions/_shared/model-failure';

const labels = { queued: 'في الانتظار', running: 'جارٍ التنفيذ', completed: 'اكتملت', failed: 'تحتاج مراجعة', cancelled: 'تم إيقاف الطلب' };

export function TaskProgress({ task, onUpdate }: { task: DurableTask; onUpdate: (task: DurableTask) => void }) {
  const { user } = useAuth();
  const [busy, setBusy] = useState<'cancel' | 'restart' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const active = task.status === 'running' || task.status === 'queued';
  useEffect(() => { if (!active) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [active]);
  const own = task.user_id === user?.id;
  const restartable = ['create', 'agent', 'analytics'].includes(task.task_kind);
  const stoppable = active && (task.status === 'queued' || restartable);
  const p = task.progress;
  const stale = task.status === 'running' && now - new Date(p?.updated_at ?? task.updated_at ?? task.created_at).getTime() > 90_000;
  const waitSeconds = Math.max(0, Math.ceil((new Date(task.available_at ?? '').getTime() - now) / 1000));
  const elapsed = Math.max(0, Math.floor(((active ? now : new Date(task.completed_at ?? task.updated_at ?? task.created_at).getTime()) - new Date(task.started_at ?? task.created_at).getTime()) / 1000));
  async function control(action: 'cancel' | 'restart') {
    if (busy) return;
    setBusy(action); setError(null);
    try { onUpdate(await (action === 'cancel' ? cancelTask(task.id) : restartTask(task.id))); }
    catch (e) { setError(e instanceof Error ? e.message : 'تعذر تنفيذ الإجراء؛ حاول مرة أخرى.'); }
    finally { setBusy(null); }
  }
  return <div className="rounded-2xl border border-brand-500/25 bg-ink-950/60 p-4" aria-live="polite" aria-atomic="true">
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-brand-300 font-medium text-sm">
        {task.status === 'running' && !stale ? <Spinner size={17} /> : task.status === 'completed' ? <CheckCircle2 size={17} /> : task.status === 'cancelled' ? <CircleStop size={17} /> : <Clock3 size={17} />}
        <span>{stale ? 'بانتظار تحديث من السيرفر' : labels[task.status]}</span>
      </div>
      <span className="text-xs text-ink-400 tabular-nums" aria-live="off">{Math.floor(elapsed / 60)}د {elapsed % 60}ث</span>
    </div>
    <p className="text-sm text-ink-100 mt-3 break-words">{task.request_text}</p>
    <div className="mt-3 flex gap-2 text-sm text-ink-300">
      <Activity size={16} className="mt-0.5 shrink-0 text-brand-400" />
      <div>
        <p>{task.status === 'cancelled' ? 'توقفت الخطوات المتبقية.' : task.status === 'completed' ? (task.result?.pendingApproval ? 'انتهى تجهيز الطلب؛ ينتظر موافقتك على الإجراء.' : task.result_type === 'clarification' ? 'انتهى فهم الطلب؛ ينتظر تفاصيل إضافية منك.' : 'انتهى تنفيذ الطلب وحُفظت النتيجة.') : task.status === 'queued' ? (task.error ? 'بانتظار إعادة المحاولة بعد تعذر الخطوة السابقة.' : p?.label ? `حُفظ التقدم؛ بانتظار استكمال التنفيذ بعد: ${p.label}` : 'تم حفظ الطلب؛ بانتظار بدء التنفيذ على السيرفر.') : p?.label ?? 'بدأ التنفيذ؛ بانتظار تفاصيل المرحلة.'}</p>
        {p?.detail && <p className="text-xs text-ink-400 mt-1">{p.detail}</p>}
        {p?.current != null && p.total != null && <p className="text-xs text-brand-300 mt-1">العنصر {p.current} من {p.total}</p>}
        {p?.provider && <p className="text-xs text-ink-400 mt-1 break-all" dir="ltr">{p.provider} · {p.model}{p.attempt && p.attempt > 1 ? ` · محاولة ${p.attempt}` : ''}</p>}
        {stale && <p className="text-xs text-warning-300 mt-1">دي آخر مرحلة مؤكدة؛ لم يصل تحديث جديد بعد.</p>}
        {task.status === 'queued' && waitSeconds > 0 && <p className="text-xs text-ink-400 mt-1" aria-live="off">إعادة المحاولة متاحة خلال {waitSeconds} ثانية.</p>}
      </div>
    </div>
    {task.error && <p className="mt-2 text-xs text-warning-300 break-words">{task.status === 'running' ? 'سبب تعذر المحاولة السابقة: ' : ''}{taskErrorMessage(task.error)}</p>}
    {own && (stoppable || restartable) && <div className="flex flex-wrap gap-2 mt-4">
      {stoppable && <Button variant="danger" size="sm" disabled={Boolean(busy)} onClick={() => void control('cancel')} className="flex gap-2 items-center">{busy === 'cancel' ? <Spinner size={14} /> : <CircleStop size={14} />}إيقاف الطلب</Button>}
      {restartable && <Button variant="secondary" size="sm" disabled={Boolean(busy)} onClick={() => void control('restart')} className="flex gap-2 items-center">{busy === 'restart' ? <Spinner size={14} /> : <RotateCcw size={14} />}البدء من جديد</Button>}
    </div>}
    {error && <div className="mt-3"><ErrorBanner message={error} /></div>}
  </div>;
}
