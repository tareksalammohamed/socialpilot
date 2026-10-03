import { useState, useRef, useEffect, useCallback } from 'react';
import { Sparkles, Send, Copy, Check, FileText, Calendar, BarChart3 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { enqueueTask } from '@/lib/tasks';
import { Button, Card, ErrorBanner, Spinner, Badge } from '@/components/ui';
import { PLATFORM_META } from '@/lib/constants';
import { parseIntent, scheduleDates, DEFAULT_SCHEDULE_HOUR } from '@/lib/intent';
import type { GeneratedContent, ContentPlan } from '@/lib/types';

type Mode = 'idle' | 'thinking' | 'content' | 'plan' | 'advice' | 'error';

type ChatTurn = { role: 'user' | 'ai'; text: string };

type AssistantTask = {
  id: string;
  workspace_id: string;
  user_id: string;
  request_text: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  result_type: 'content' | 'plan' | 'advice' | 'clarification' | null;
  result: Record<string, unknown> | null;
  error: string | null;
  content_id: string | null;
  batch_id: string | null;
  created_at: string;
  updated_at: string;
};

function toScheduledIso(date: string): string {
  return `${date}T${String(DEFAULT_SCHEDULE_HOUR).padStart(2, '0')}:00:00.000Z`;
}

function qualityStatusOf(verdict: string | undefined): 'pending' | 'passed' | 'needs_improvement' | 'failed' {
  if (verdict === 'pass') return 'passed';
  if (verdict === 'fail') return 'failed';
  if (verdict === 'review') return 'needs_improvement';
  return 'pending';
}

function averageScore(scores: Record<string, number> | undefined): number | null {
  const values = Object.values(scores ?? {}).filter((v): v is number => typeof v === 'number');
  return values.length > 0 ? Math.round(values.reduce((sum, v) => sum + v, 0) / values.length) : null;
}

const SUGGESTIONS = [
  'اكتبلي بوست قوي عن التأمين',
  'اعملّي خطة محتوى للأسبوع الجاي',
  'اقترح عليّ 5 أفكار محتوى',
  'حلل أداء الصفحة وقولي أعمل إيه',
];

export function CreateScreen() {
  const { workspace, user } = useAuth();
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<Mode>('idle');
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState<GeneratedContent | null>(null);
  const [plan, setPlan] = useState<ContentPlan | null>(null);
  const [advice, setAdvice] = useState<string | null>(null);
  const [chat, setChat] = useState<ChatTurn[]>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [savingPlan, setSavingPlan] = useState(false);
  const [planSaved, setPlanSaved] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [restoringTask, setRestoringTask] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [chat, mode]);

  const applyTask = useCallback((task: AssistantTask) => {
    setActiveTaskId(task.id);
    setError(null);
    setContent(null);
    setPlan(null);
    setAdvice(null);
    setSaved(Boolean(task.content_id));
    setPlanSaved(Boolean(task.batch_id));

    if (task.status === 'running' || task.status === 'queued') {
      setChat([{ role: 'user', text: task.request_text }]);
      setMode('thinking');
      return;
    }

    if (task.status === 'failed') {
      const message = task.error || 'فشل تنفيذ الطلب';
      setChat([
        { role: 'user', text: task.request_text },
        { role: 'ai', text: `خطأ: ${message}` },
      ]);
      setError(message);
      setMode('error');
      return;
    }

    const payload = task.result ?? {};
    if (task.result_type === 'clarification') {
      const question = typeof payload.text === 'string' ? payload.text : 'محتاج تفاصيل إضافية قبل التنفيذ.';
      setChat([
        { role: 'user', text: task.request_text },
        { role: 'ai', text: question },
      ]);
      setMode('idle');
      return;
    }

    if (task.result_type === 'content') {
      const generated = payload as unknown as GeneratedContent;
      setContent(generated);
      setChat([
        { role: 'user', text: task.request_text },
        { role: 'ai', text: summarizeResult(payload, 'create_content') },
      ]);
      setMode('content');
      return;
    }

    if (task.result_type === 'plan') {
      const generatedPlan = payload as unknown as ContentPlan;
      setPlan(generatedPlan);
      setChat([
        { role: 'user', text: task.request_text },
        { role: 'ai', text: summarizeResult(payload, 'create_content_plan') },
      ]);
      setMode('plan');
      return;
    }

    const answer = typeof payload.advice === 'string' ? payload.advice : 'تم';
    setAdvice(answer);
    setChat([
      { role: 'user', text: task.request_text },
      { role: 'ai', text: answer },
    ]);
    setMode('advice');
  }, []);

  useEffect(() => {
    if (!workspace?.id || !user?.id) {
      setRestoringTask(false);
      return;
    }
    let cancelled = false;

    void (async () => {
      const { data, error: taskError } = await supabase
        .from('assistant_tasks')
        .select('*')
        .eq('workspace_id', workspace.id)
        .eq('user_id', user.id)
        .eq('task_kind', 'create')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (cancelled) return;
      if (taskError) {
        setError(taskError.message);
        setMode('error');
      } else if (data) {
        applyTask(data as AssistantTask);
      }
      setRestoringTask(false);
    })();

    const poll = setInterval(() => {
      void supabase.from('assistant_tasks').select('*').eq('workspace_id', workspace.id)
        .eq('user_id', user.id).eq('task_kind', 'create').order('created_at', { ascending: false })
        .limit(1).maybeSingle().then(({ data }) => { if (!cancelled && data) applyTask(data as AssistantTask); });
    }, 5000);
    const channel = supabase
      .channel(`assistant-tasks:${workspace.id}:${user.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'assistant_tasks',
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          const task = payload.new as AssistantTask;
          if (task.workspace_id !== workspace.id || (task as AssistantTask & { task_kind: string }).task_kind !== 'create') return;
          if (!activeTaskId || task.id === activeTaskId) applyTask(task);
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      clearInterval(poll);
      void supabase.removeChannel(channel);
    };
  }, [workspace?.id, user?.id, activeTaskId, applyTask]);

  async function handleSubmit(text?: string) {
    const message = text ?? input;
    if (!message.trim() || !workspace || !user) return;

    setInput('');
    setError(null);
    setContent(null);
    setPlan(null);
    setAdvice(null);
    setSaved(false);
    setPlanSaved(false);
    setChat((prev) => [...prev, { role: 'user', text: message }]);
    setMode('thinking');

    // parseIntent stays as the deterministic, non-AI source for post
    // count/dates/platforms — the Universal Agent decides WHICH tool to run,
    // but this data still drives create_content_plan's exact slot count
    // (see the note in agent/types.ts on `legacyContext`).
    const parsed = parseIntent(message);
    try {
      const taskId = await enqueueTask(workspace.id, 'create', {
        message: message.trim(), platforms: parsed.platforms,
        agentContext: { currentRoute: 'create' },
        legacyContext: {
          post_count: parsed.postCount, start_date: parsed.startDate, end_date: parsed.endDate,
          frequency: parsed.frequency, schedule: parsed.schedule, content_goal: parsed.contentGoal,
          content_type: parsed.contentType, platforms: parsed.platforms,
        },
      });
      setActiveTaskId(taskId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'تعذّر إرسال المهمة';
      setError(msg); setMode('error');
    }
  }

  async function saveContent(targetContent?: GeneratedContent, sourceMessage?: string): Promise<string | null> {
    const contentToSave = targetContent ?? content;
    if (!contentToSave || !workspace) return null;
    setSaving(true);
    try {
      const { data: inserted, error: contentError } = await supabase
        .from('content')
        .insert({
          workspace_id: workspace.id,
          title: contentToSave.title,
          goal: contentToSave.goal,
          topic: contentToSave.topic,
          audience: contentToSave.audience,
          master_text: contentToSave.master_text,
          platforms: contentToSave.platforms,
          status: 'draft',
        })
        .select()
        .single();
      if (contentError || !inserted) throw contentError ?? new Error('فشل حفظ المحتوى');

      if (contentToSave.variants.length > 0) {
        const userTurns = chat.filter((turn) => turn.role === 'user');
        const parsed = parseIntent(sourceMessage ?? userTurns[userTurns.length - 1]?.text ?? '');
        const scheduledDates = scheduleDates(parsed, contentToSave.variants.length);
        const quality = contentToSave.quality;
        const scoreValues = Object.values(quality?.scores ?? {}).filter((score): score is number => typeof score === 'number');
        const qualityScore = scoreValues.length > 0 ? Math.round(scoreValues.reduce((sum, score) => sum + score, 0) / scoreValues.length) : null;
        const variantQualityStatus = qualityStatusOf(quality?.verdict);
        const { data: insertedVariants, error: variantsError } = await supabase.from('content_variants').insert(
          contentToSave.variants.map((v) => ({
            content_id: inserted.id,
            workspace_id: workspace.id,
            platform: v.platform,
            text: v.text,
            hashtags: v.hashtags,
            cta: v.cta,
            media_brief: v.media_brief,
            status: 'review',
            quality_score: qualityScore,
            quality_status: variantQualityStatus,
          }))
        ).select('id, platform');
        if (variantsError) throw variantsError;

        if (quality && insertedVariants?.length) {
          await supabase.from('quality_reviews').insert(insertedVariants.map((variant) => ({
            variant_id: variant.id,
            workspace_id: workspace.id,
            verdict: quality.verdict,
            scores: quality.scores,
            reasons: [...quality.reasons, ...(quality.suggested_improvements ?? [])],
            fixes_applied: 0,
          })));
          await supabase.from('content').update({
            quality_score: qualityScore,
            quality_status: quality.verdict === 'pass' ? 'passed' : quality.verdict === 'fail' ? 'failed' : 'needs_improvement',
          }).eq('id', inserted.id).eq('workspace_id', workspace.id);
        }

        if (scheduledDates.length > 0) {
          const { data: variants } = await supabase
            .from('content_variants')
            .select('id, platform')
            .eq('content_id', inserted.id)
            .order('created_at', { ascending: true });
          if (variants?.length) {
            for (const [index, variant] of variants.entries()) {
              const scheduledFor = toScheduledIso(scheduledDates[index] ?? scheduledDates[scheduledDates.length - 1]);
              const rpcName = quality?.verdict === 'pass' ? 'approve_content_variant' : 'schedule_content_variant';
              const { error: scheduleError } = await supabase.rpc(rpcName, {
                p_workspace_id: workspace.id,
                p_variant_id: variant.id,
                p_scheduled_for: scheduledFor,
              });
              if (scheduleError) throw scheduleError;
            }
          }
          await supabase.from('content').update({
            status: quality?.verdict === 'pass' ? 'scheduled' : 'review',
          }).eq('id', inserted.id).eq('workspace_id', workspace.id);
        }
      }
      setSaved(true);
      return inserted.id as string;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'فشل حفظ المحتوى';
      setError(message);
      throw err;
    } finally {
      setSaving(false);
    }
  }

  async function savePlan(targetPlan?: ContentPlan): Promise<string | null> {
    const planToSave = targetPlan ?? plan;
    if (!planToSave || !workspace || planToSave.slots.length === 0) return null;
    setSavingPlan(true);
    setError(null);
    try {
      const batchId = crypto.randomUUID();
      for (const slot of planToSave.slots) {
        const body = slot.content?.trim() || slot.title;
        const scheduledIso = toScheduledIso(slot.date);
        const qualityStatus = qualityStatusOf(slot.quality?.verdict);
        const qualityScore = averageScore(slot.quality?.scores);

        const { data: inserted, error: contentError } = await supabase
          .from('content')
          .insert({
            workspace_id: workspace.id,
            batch_id: batchId,
            title: slot.title,
            goal: slot.goal || planToSave.theme,
            topic: planToSave.theme,
            master_text: body,
            platforms: [slot.platform],
            status: qualityStatus === 'passed' ? 'scheduled' : 'review',
            scheduled_at: scheduledIso,
            quality_score: qualityScore,
            quality_status: qualityStatus,
          })
          .select('id')
          .single();
        if (contentError || !inserted) throw contentError ?? new Error('فشل إنشاء عنصر الخطة');

        const { data: variant, error: variantError } = await supabase
          .from('content_variants')
          .insert({
            content_id: inserted.id,
            workspace_id: workspace.id,
            platform: slot.platform,
            text: body,
            hashtags: slot.hashtags ?? [],
            cta: slot.cta ?? null,
            media_brief: {},
            status: 'review',
            scheduled_at: scheduledIso,
            quality_score: qualityScore,
            quality_status: qualityStatus,
          })
          .select('id')
          .single();
        if (variantError || !variant) throw variantError ?? new Error('فشل إنشاء نسخة المنصة');

        if (slot.quality) {
          await supabase.from('quality_reviews').insert({
            variant_id: variant.id,
            workspace_id: workspace.id,
            verdict: slot.quality.verdict,
            scores: slot.quality.scores,
            reasons: [...(slot.quality.reasons ?? []), ...(slot.quality.suggested_improvements ?? [])],
            fixes_applied: 0,
          });
        }

        const rpcName = slot.quality?.verdict === 'pass' ? 'approve_content_variant' : 'schedule_content_variant';
        const { error: calendarError } = await supabase.rpc(rpcName, {
          p_workspace_id: workspace.id,
          p_variant_id: variant.id,
          p_scheduled_for: scheduledIso,
        });
        if (calendarError) throw calendarError;
        if (slot.quality?.verdict !== 'pass') {
          await supabase.from('content')
            .update({ status: 'review' })
            .eq('id', inserted.id)
            .eq('workspace_id', workspace.id);
        }
      }
      setPlanSaved(true);
      return batchId;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'فشل حفظ خطة المحتوى';
      setError(message);
      throw err;
    } finally {
      setSavingPlan(false);
    }
  }

  function copyText(text: string, id: string) {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  }

  return (
    <div className="page-shell safe-top pb-28 max-w-5xl flex flex-col min-h-[calc(100vh-7rem)]">
      <section className="surface-hero mb-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="status-orb"><Sparkles size={21} className="text-brand-300" /></div>
            <div>
              <p className="eyebrow">AI CONTENT STUDIO</p>
              <h1 className="text-2xl font-bold text-ink-50 mt-1">أنشئ ونفّذ بالذكاء الاصطناعي</h1>
              <p className="text-ink-400 text-sm mt-2">اطلب بوست، خطة، تحليل أو تعديل — والتنفيذ يكمل على السيرفر حتى لو قفلت التطبيق.</p>
            </div>
          </div>
          <Badge color={mode === 'thinking' ? 'accent' : mode === 'error' ? 'danger' : content || plan || advice ? 'brand' : 'neutral'}>
            {mode === 'thinking' ? 'يعمل الآن' : mode === 'error' ? 'يحتاج مراجعة' : content || plan || advice ? 'النتيجة جاهزة' : 'جاهز'}
          </Badge>
        </div>
      </section>

      {/* Chat + results */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto no-scrollbar rounded-2xl border border-ink-800 bg-ink-950/40 p-4 sm:p-5">
        {restoringTask ? (
          <div className="py-16 flex items-center justify-center gap-2 text-ink-500 text-sm">
            <Spinner size={18} className="text-brand-400" />
            استرجاع آخر عملية...
          </div>
        ) : chat.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 animate-fade-in">
            <div className="w-16 h-16 rounded-2xl bg-brand-500/15 border border-brand-500/30 flex items-center justify-center mb-4">
              <Sparkles className="text-brand-400" size={32} />
            </div>
            <p className="text-ink-300 text-sm text-center max-w-xs mb-6">
              اكتب أي حاجة بالعربي أو بالمصري. النظام يفهم المقصود وينفذ المهمة.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 w-full max-w-3xl">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => handleSubmit(s)}
                  className="text-right px-4 py-3.5 rounded-xl bg-ink-900/80 border border-ink-800 text-ink-200 text-sm hover:border-brand-500/30 hover:bg-ink-800/70 transition-all active:scale-[0.98]"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Chat messages */}
        <div className="flex flex-col gap-3 mb-4">
          {chat.map((turn, i) => (
            <div
              key={i}
              className={`flex ${turn.role === 'user' ? 'justify-start' : 'justify-end'}`}
            >
              <div
                className={`max-w-[85%] px-4 py-2.5 rounded-2xl text-sm ${
                  turn.role === 'user'
                    ? 'bg-brand-500 text-ink-950 rounded-bl-md'
                    : 'bg-ink-800 text-ink-100 rounded-br-md'
                }`}
              >
                {turn.text}
              </div>
            </div>
          ))}
        </div>

        {mode === 'thinking' && (
          <div className="flex justify-end mb-4">
            <div className="bg-ink-800 rounded-2xl rounded-br-md px-4 py-3 flex items-center gap-2">
              <Spinner className="text-brand-400" size={16} />
              <span className="text-ink-400 text-sm">يفكر وينفذ...</span>
            </div>
          </div>
        )}

        {error && mode === 'error' && (
          <div className="mb-4">
            <ErrorBanner message={error} />
          </div>
        )}

        {/* Content result */}
        {content && mode === 'content' && (
          <div className="flex flex-col gap-3 animate-slide-up">
            <Card className="surface-card">
              <div className="flex items-center gap-2 mb-2">
                <FileText size={16} className="text-brand-400" />
                <p className="text-ink-100 font-medium">{content.title}</p>
              </div>
              <p className="text-ink-400 text-sm">{content.master_text}</p>
            </Card>

            {content.quality && <SingleContentQuality quality={content.quality} />}

            <p className="text-ink-500 text-xs px-1">نسخ المنصات ({content.variants.length})</p>
            {content.variants.map((v, i) => {
              const meta = PLATFORM_META[v.platform as keyof typeof PLATFORM_META];
              const Icon = meta?.icon;
              return (
                <Card key={i}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      {Icon && <Icon size={16} style={{ color: meta.color }} />}
                      <span className="text-ink-200 text-sm font-medium">{meta?.label ?? v.platform}</span>
                    </div>
                    <button
                      onClick={() => copyText(v.text, `v${i}`)}
                      className="text-ink-500 hover:text-ink-200 transition-colors"
                    >
                      {copied === `v${i}` ? <Check size={16} className="text-brand-400" /> : <Copy size={16} />}
                    </button>
                  </div>
                  <p className="text-ink-100 text-sm whitespace-pre-wrap leading-relaxed">{v.text}</p>
                  {v.hashtags.length > 0 && (
                    <p className="text-accent-400 text-xs mt-2">{v.hashtags.join(' ')}</p>
                  )}
                  {v.cta && <p className="text-brand-400 text-xs mt-1">CTA: {v.cta}</p>}
                </Card>
              );
            })}

            {saved ? (
              <div className="flex items-center justify-center gap-2 py-3 text-brand-400">
                <Check size={18} /> <span className="text-sm">تم حفظ المحتوى</span>
              </div>
            ) : (
              <Button onClick={() => void saveContent().catch(() => setMode('error'))} disabled={saving} size="lg">
                {saving ? 'جارٍ الحفظ...' : 'حفظ في المحتوى'}
              </Button>
            )}
          </div>
        )}

        {/* Plan result */}
        {plan && mode === 'plan' && (
          <div className="flex flex-col gap-3 animate-slide-up">
            <Card>
              <div className="flex items-center gap-2 mb-2">
                <Calendar size={16} className="text-brand-400" />
                <p className="text-ink-100 font-medium">خطة المحتوى: {plan.theme}</p>
              </div>
            </Card>
            <p className="text-ink-500 text-xs px-1">المنشورات ({plan.slots.length})</p>
            {plan.slots.map((slot, i) => {
              const meta = PLATFORM_META[slot.platform as keyof typeof PLATFORM_META];
              const qStatus = qualityStatusOf(slot.quality?.verdict);
              const qColor = qStatus === 'passed' ? 'brand' : qStatus === 'failed' ? 'danger' : 'accent';
              const qLabel = qStatus === 'passed' ? 'جاهز' : qStatus === 'failed' ? 'مرفوض' : qStatus === 'needs_improvement' ? 'يحتاج تحسين' : 'قيد التقييم';
              return (
                <Card key={i}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Badge color="brand">{meta?.label ?? slot.platform}</Badge>
                      <span className="text-ink-500 text-xs">{slot.date}</span>
                    </div>
                    <Badge color={qColor}>{qLabel}{typeof averageScore(slot.quality?.scores) === 'number' ? ` · ${averageScore(slot.quality?.scores)}` : ''}</Badge>
                  </div>
                  <p className="text-ink-100 text-sm font-medium">{slot.title}</p>
                  {slot.content && <p className="text-ink-400 text-xs mt-1 whitespace-pre-wrap leading-relaxed">{slot.content}</p>}
                  {slot.quality?.reasons && slot.quality.reasons.length > 0 && qStatus !== 'passed' && (
                    <p className="text-ink-500 text-xs mt-2">ملاحظات: {slot.quality.reasons.join('، ')}</p>
                  )}
                </Card>
              );
            })}
            {planSaved ? (
              <div className="flex items-center justify-center gap-2 py-3 text-brand-400">
                <Check size={18} /> <span className="text-sm">تم حفظ الخطة وربطها بالتقويم</span>
              </div>
            ) : (
              <Button onClick={() => void savePlan().catch(() => setMode('error'))} disabled={savingPlan} size="lg">
                {savingPlan ? 'جارٍ حفظ الخطة...' : 'حفظ الخطة في المحتوى والتقويم'}
              </Button>
            )}
          </div>
        )}

        {/* Advice result */}
        {advice && mode === 'advice' && (
          <Card className="animate-slide-up">
            <div className="flex items-center gap-2 mb-2">
              <BarChart3 size={16} className="text-accent-400" />
              <p className="text-ink-300 text-sm font-medium">النتيجة</p>
            </div>
            <p className="text-ink-100 text-sm leading-relaxed">{advice}</p>
          </Card>
        )}
      </div>

      {/* Command bar */}
      <div className="sticky bottom-2 mt-3 p-2.5 glass rounded-2xl border border-ink-800 shadow-2xl shadow-black/25">
        <div className="flex items-center gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
            placeholder="اكتب طلبك بالعربي..."
            className="flex-1 bg-ink-950/80 border border-ink-700 rounded-xl px-4 py-3 text-ink-100 text-sm placeholder:text-ink-500 focus:border-brand-500/50 focus:outline-none"
          />
          <button
            onClick={() => handleSubmit()}
            disabled={!input.trim() || mode === 'thinking'}
            className="w-11 h-11 rounded-xl bg-brand-500 text-ink-950 flex items-center justify-center disabled:opacity-30 active:scale-95 transition-all shadow-lg shadow-brand-500/15"
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}

function SingleContentQuality({
  quality,
}: {
  quality: NonNullable<GeneratedContent['quality']>;
}) {
  const status = qualityStatusOf(quality.verdict);
  const score = averageScore(quality.scores);
  const badgeColor = status === 'passed' ? 'brand' : status === 'failed' ? 'danger' : 'warning';
  const label = status === 'passed' ? 'اجتاز المراجعة' : status === 'failed' ? 'فشل المراجعة' : 'يحتاج تحسين';
  const reasons = quality.reasons ?? [];
  const suggestions = quality.suggested_improvements ?? [];

  return (
    <Card className="border-brand-500/20">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <p className="text-ink-200 text-sm font-medium">مراجعة الجودة</p>
          <p className="text-ink-500 text-xs mt-1">تقييم آلي قبل الحفظ والاعتماد</p>
        </div>
        <Badge color={badgeColor}>{label}{typeof score === 'number' ? ` · ${score}/100` : ''}</Badge>
      </div>
      {reasons.length > 0 && (
        <div className="mb-3">
          <p className="text-ink-400 text-xs mb-1">المشكلات الرئيسية</p>
          <ul className="flex flex-col gap-1 text-ink-300 text-xs list-disc pr-4">
            {reasons.map((reason, index) => <li key={`${reason}-${index}`}>{reason}</li>)}
          </ul>
        </div>
      )}
      {suggestions.length > 0 && (
        <div>
          <p className="text-ink-400 text-xs mb-1">التحسينات المقترحة</p>
          <ul className="flex flex-col gap-1 text-accent-300 text-xs list-disc pr-4">
            {suggestions.map((suggestion, index) => <li key={`${suggestion}-${index}`}>{suggestion}</li>)}
          </ul>
        </div>
      )}
      {reasons.length === 0 && suggestions.length === 0 && (
        <p className="text-ink-500 text-xs">لم تُرجع المراجعة ملاحظات إضافية.</p>
      )}
    </Card>
  );
}

function summarizeResult(result: Record<string, unknown>, intent: string): string {
  if (intent === 'create_content') {
    const c = result as GeneratedContent;
    return `تم إنشاء محتوى "${c.title}" مع ${c.variants?.length ?? 0} نسخ للمنصات.`;
  }
  if (intent === 'create_content_plan') {
    const p = result as ContentPlan;
    return `تم بناء خطة محتوى "${p.theme}" بـ ${p.slots?.length ?? 0} فترات.`;
  }
  const r = result as { advice?: string };
  return r.advice ?? 'تم';
}
