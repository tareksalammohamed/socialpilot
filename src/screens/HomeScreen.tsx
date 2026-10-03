import { useEffect, useMemo, useState } from 'react';
import {
  Sparkles,
  AlertTriangle,
  ArrowLeft,
  Zap,
  Send,
  CalendarClock,
  MessageSquareText,
  FileCheck2,
  Radio,
  Clock3,
  CheckCircle2,
  RotateCcw,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { callAiGateway } from '@/lib/api';
import { Card, ScreenLoader, ErrorBanner, Button, Spinner, Badge } from '@/components/ui';
import { PLATFORM_META } from '@/lib/constants';
import type { SocialAccount, Content, SocialPlatform } from '@/lib/types';
import type { Tab } from '@/components/AppShell';

type DashboardConversation = {
  id: string;
  unread: boolean;
  needs_review: boolean;
  status: 'open' | 'pending' | 'closed';
};

type DashboardPublishingJob = {
  id: string;
  platform: string | null;
  status: string;
  last_error: string | null;
  created_at: string;
};

type DashboardCalendarItem = {
  id: string;
  platform: string;
  scheduled_for: string;
  status: string;
};

type DashboardAssistantTask = {
  id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  request_text: string;
  result_type: string | null;
  error: string | null;
  updated_at: string;
};

function formatSchedule(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('ar-EG', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function statusLabel(status: Content['status']): string {
  const labels: Record<Content['status'], string> = {
    idea: 'فكرة',
    draft: 'مسودة',
    review: 'مراجعة',
    approved: 'معتمد',
    scheduled: 'مجدول',
    published: 'منشور',
    rejected: 'مرفوض',
  };
  return labels[status];
}

export function HomeScreen({ onNavigate }: { onNavigate: (tab: Tab) => void }) {
  const { workspace } = useAuth();
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [content, setContent] = useState<Content[]>([]);
  const [conversations, setConversations] = useState<DashboardConversation[]>([]);
  const [failedJobs, setFailedJobs] = useState<DashboardPublishingJob[]>([]);
  const [upcoming, setUpcoming] = useState<DashboardCalendarItem[]>([]);
  const [latestTask, setLatestTask] = useState<DashboardAssistantTask | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [advice, setAdvice] = useState<string | null>(null);
  const [adviceLoading, setAdviceLoading] = useState(false);
  const [adviceError, setAdviceError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspace) return;
    let cancelled = false;

    void (async () => {
      setLoading(true);
      setLoadError(null);
      const now = new Date().toISOString();
      const [accs, contentRows, inboxRows, jobs, calendarRows, task] = await Promise.all([
        supabase.from('social_accounts').select('*').eq('workspace_id', workspace.id).order('platform'),
        supabase.from('content').select('*').eq('workspace_id', workspace.id).order('created_at', { ascending: false }).limit(60),
        supabase.from('inbox_conversations').select('id,unread,needs_review,status').eq('workspace_id', workspace.id),
        supabase
          .from('publishing_jobs')
          .select('id,platform,status,last_error,created_at')
          .eq('workspace_id', workspace.id)
          .eq('status', 'failed')
          .order('created_at', { ascending: false })
          .limit(5),
        supabase
          .from('calendar_items')
          .select('id,platform,scheduled_for,status')
          .eq('workspace_id', workspace.id)
          .in('status', ['planned', 'scheduled'])
          .gte('scheduled_for', now)
          .order('scheduled_for', { ascending: true })
          .limit(5),
        supabase
          .from('assistant_tasks')
          .select('id,status,request_text,result_type,error,updated_at')
          .eq('workspace_id', workspace.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      const firstError = accs.error ?? contentRows.error ?? inboxRows.error ?? jobs.error ?? calendarRows.error ?? task.error;
      if (cancelled) return;
      if (firstError) setLoadError(firstError.message);
      setAccounts((accs.data as SocialAccount[]) ?? []);
      setContent((contentRows.data as Content[]) ?? []);
      setConversations((inboxRows.data as DashboardConversation[]) ?? []);
      setFailedJobs((jobs.data as DashboardPublishingJob[]) ?? []);
      setUpcoming((calendarRows.data as DashboardCalendarItem[]) ?? []);
      setLatestTask((task.data as DashboardAssistantTask | null) ?? null);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [workspace]);

  async function loadAdvice() {
    if (!workspace) return;
    setAdviceLoading(true);
    setAdviceError(null);
    try {
      const res = await callAiGateway({
        intent: 'general_advice',
        workspaceId: workspace.id,
        message: 'اقترح فكرة محتوى واحدة عملية وقوية لليوم بناءً على Brand DNA وأداء المحتوى الحالي. أجب باختصار.',
      });
      const result = res.result as { advice?: string };
      setAdvice(result.advice ?? 'لا توجد اقتراحات حالياً');
    } catch (error) {
      setAdviceError(error instanceof Error ? error.message : 'فشل تحميل الاقتراح');
    } finally {
      setAdviceLoading(false);
    }
  }

  const metrics = useMemo(() => {
    const connected = accounts.filter((account) => account.status === 'connected').length;
    const scheduled = content.filter((item) => item.status === 'scheduled').length;
    const review = content.filter((item) => item.status === 'review' || item.quality_status === 'needs_improvement').length;
    const published = content.filter((item) => item.status === 'published').length;
    const unread = conversations.filter((item) => item.unread).length;
    const inboxReview = conversations.filter((item) => item.needs_review).length;
    return { connected, scheduled, review, published, unread, inboxReview };
  }, [accounts, content, conversations]);

  const recentContent = content.slice(0, 4);
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'صباح الخير' : hour < 18 ? 'مساء الخير' : 'مساء الخير';

  if (loading) return <ScreenLoader label="جارٍ تجهيز مركز التشغيل..." />;

  return (
    <div className="page-shell safe-top pb-28">
      <section className="surface-hero mb-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="eyebrow">SOCIALPILOT COMMAND CENTER</p>
            <p className="text-ink-400 text-sm mt-1">{greeting}</p>
            <h1 className="text-2xl sm:text-3xl font-bold text-ink-50 mt-1 truncate">{workspace?.name}</h1>
            <p className="text-ink-400 text-sm mt-2">
              التأليف، الجدولة، النشر والرسائل من لوحة تشغيل واحدة.
            </p>
          </div>
          <div className="status-orb">
            {failedJobs.length > 0 ? (
              <AlertTriangle size={21} className="text-warning-400" />
            ) : (
              <Radio size={21} className="text-brand-300" />
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-5">
          <div className="metric-tile">
            <p className="metric-value">{metrics.connected}</p>
            <p className="metric-label">حسابات متصلة</p>
          </div>
          <div className="metric-tile">
            <p className="metric-value">{metrics.scheduled}</p>
            <p className="metric-label">مجدول للنشر</p>
          </div>
          <div className="metric-tile">
            <p className={`metric-value ${metrics.unread ? 'text-accent-300' : ''}`}>{metrics.unread}</p>
            <p className="metric-label">رسائل جديدة</p>
          </div>
          <div className="metric-tile">
            <p className={`metric-value ${failedJobs.length ? 'text-warning-300' : ''}`}>{failedJobs.length}</p>
            <p className="metric-label">مشاكل نشر</p>
          </div>
        </div>
      </section>

      {loadError && <div className="mb-4"><ErrorBanner message={loadError} /></div>}

      <section className="mb-5">
        <div className="section-heading">
          <div>
            <p className="eyebrow">QUICK ACTIONS</p>
            <h2 className="section-title">ابدأ من هنا</h2>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <button onClick={() => onNavigate('create')} className="quick-action-card text-right">
            <div className="quick-action-icon"><Sparkles size={19} /></div>
            <div>
              <p className="text-ink-100 text-sm font-semibold">أنشئ بالـAI</p>
              <p className="text-ink-500 text-xs mt-1">بوست، خطة أو تعديل</p>
            </div>
          </button>
          <button onClick={() => onNavigate('content')} className="quick-action-card text-right">
            <div className="quick-action-icon"><CalendarClock size={19} /></div>
            <div>
              <p className="text-ink-100 text-sm font-semibold">المحتوى والجدولة</p>
              <p className="text-ink-500 text-xs mt-1">{metrics.scheduled} مجدول · {metrics.review} مراجعة</p>
            </div>
          </button>
          <button onClick={() => onNavigate('inbox')} className="quick-action-card text-right">
            <div className="quick-action-icon"><MessageSquareText size={19} /></div>
            <div>
              <p className="text-ink-100 text-sm font-semibold">Unified Inbox</p>
              <p className="text-ink-500 text-xs mt-1">{metrics.unread} غير مقروء · {metrics.inboxReview} AI review</p>
            </div>
          </button>
        </div>
      </section>

      {((latestTask?.status === 'running' || latestTask?.status === 'queued') || failedJobs.length > 0 || metrics.review > 0 || metrics.unread > 0) && (
        <section className="mb-5">
          <div className="section-heading">
            <div>
              <p className="eyebrow">ATTENTION</p>
              <h2 className="section-title">ما يحتاج تصرفك</h2>
            </div>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {(latestTask?.status === 'running' || latestTask?.status === 'queued') && (
              <Card onClick={() => onNavigate('create')} className="surface-card">
                <div className="flex items-center gap-3">
                  <div className="icon-well"><Spinner size={17} className="text-brand-300" /></div>
                  <div className="min-w-0 flex-1">
                    <p className="text-ink-100 text-sm font-semibold">AI يعمل الآن</p>
                    <p className="text-ink-500 text-xs mt-1 truncate">{latestTask.request_text}</p>
                  </div>
                  <ArrowLeft size={15} className="text-ink-600" />
                </div>
              </Card>
            )}

            {failedJobs.length > 0 && (
              <Card onClick={() => onNavigate('content')} className="surface-card border-warning-500/30">
                <div className="flex items-center gap-3">
                  <div className="icon-well"><RotateCcw size={17} className="text-warning-400" /></div>
                  <div className="min-w-0 flex-1">
                    <p className="text-ink-100 text-sm font-semibold">{failedJobs.length} مهمة نشر فشلت</p>
                    <p className="text-warning-300 text-xs mt-1 truncate">{failedJobs[0]?.last_error || 'تحتاج إعادة المحاولة'}</p>
                  </div>
                  <ArrowLeft size={15} className="text-ink-600" />
                </div>
              </Card>
            )}

            {metrics.review > 0 && (
              <Card onClick={() => onNavigate('content')} className="surface-card">
                <div className="flex items-center gap-3">
                  <div className="icon-well"><FileCheck2 size={17} className="text-accent-400" /></div>
                  <div className="flex-1">
                    <p className="text-ink-100 text-sm font-semibold">{metrics.review} محتوى يحتاج مراجعة</p>
                    <p className="text-ink-500 text-xs mt-1">راجع الجودة واعتمد قبل النشر.</p>
                  </div>
                  <ArrowLeft size={15} className="text-ink-600" />
                </div>
              </Card>
            )}

            {metrics.unread > 0 && (
              <Card onClick={() => onNavigate('inbox')} className="surface-card">
                <div className="flex items-center gap-3">
                  <div className="icon-well"><MessageSquareText size={17} className="text-brand-300" /></div>
                  <div className="flex-1">
                    <p className="text-ink-100 text-sm font-semibold">{metrics.unread} رسالة تنتظر الرد</p>
                    <p className="text-ink-500 text-xs mt-1">افتح الـInbox واستفد من اقتراحات AI.</p>
                  </div>
                  <ArrowLeft size={15} className="text-ink-600" />
                </div>
              </Card>
            )}
          </div>
        </section>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <section>
          <div className="section-heading">
            <div>
              <p className="eyebrow">UPCOMING</p>
              <h2 className="section-title">الجدول القادم</h2>
            </div>
            <button onClick={() => onNavigate('content')} className="text-ink-500 hover:text-ink-200 text-xs flex items-center gap-1">
              التقويم <ArrowLeft size={12} />
            </button>
          </div>

          {upcoming.length === 0 ? (
            <Card className="surface-card">
              <div className="flex items-center gap-3 py-2">
                <div className="icon-well"><Clock3 size={18} className="text-ink-500" /></div>
                <div>
                  <p className="text-ink-200 text-sm font-medium">لا توجد منشورات قادمة</p>
                  <p className="text-ink-500 text-xs mt-1">أنشئ خطة محتوى وسيظهر جدول النشر هنا.</p>
                </div>
              </div>
            </Card>
          ) : (
            <div className="flex flex-col gap-2">
              {upcoming.map((item) => {
                const meta = PLATFORM_META[item.platform as SocialPlatform];
                const Icon = meta?.icon;
                return (
                  <Card key={item.id} onClick={() => onNavigate('content')} className="surface-card">
                    <div className="flex items-center gap-3">
                      <div className="platform-icon" style={{ borderColor: `${meta?.color ?? '#52525b'}55` }}>
                        {Icon ? <Icon size={17} style={{ color: meta.color }} /> : <Send size={17} className="text-ink-500" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-ink-200 text-sm font-medium">{meta?.label ?? item.platform}</p>
                        <p className="text-ink-500 text-xs mt-1">{formatSchedule(item.scheduled_for)}</p>
                      </div>
                      <Badge color={item.status === 'scheduled' ? 'brand' : 'neutral'}>
                        {item.status === 'scheduled' ? 'جاهز للنشر' : 'مخطط'}
                      </Badge>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </section>

        <section>
          <div className="section-heading">
            <div>
              <p className="eyebrow">AI COPILOT</p>
              <h2 className="section-title">اقتراح اليوم</h2>
            </div>
            {advice && <CheckCircle2 size={16} className="text-brand-400" />}
          </div>
          <Card className="surface-card min-h-[132px]">
            {adviceLoading ? (
              <div className="flex items-center gap-2 text-ink-400 text-sm py-4">
                <Spinner className="text-brand-400" /> يحلل البراند والأداء...
              </div>
            ) : adviceError ? (
              <div>
                <ErrorBanner message={adviceError} />
                <Button variant="ghost" size="sm" onClick={() => void loadAdvice()} className="mt-2">إعادة المحاولة</Button>
              </div>
            ) : advice ? (
              <div>
                <p className="text-ink-100 text-sm leading-7">{advice}</p>
                <Button variant="ghost" size="sm" onClick={() => onNavigate('create')} className="mt-3">
                  حوّل الفكرة لمحتوى
                </Button>
              </div>
            ) : (
              <div>
                <p className="text-ink-300 text-sm">اطلب فكرة مبنية على Brand DNA وحالة المحتوى الحالية.</p>
                <Button size="sm" onClick={() => void loadAdvice()} className="mt-3">
                  <span className="flex items-center gap-1.5"><Zap size={14} /> حلّل واقترح</span>
                </Button>
              </div>
            )}
          </Card>
        </section>
      </div>

      {recentContent.length > 0 && (
        <section className="mt-5">
          <div className="section-heading">
            <div>
              <p className="eyebrow">RECENT CONTENT</p>
              <h2 className="section-title">آخر المحتوى</h2>
            </div>
            <span className="text-ink-600 text-xs">{metrics.published} منشور</span>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            {recentContent.map((item) => (
              <Card key={item.id} onClick={() => onNavigate('content')} className="surface-card">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-ink-100 text-sm font-semibold truncate">{item.title}</p>
                    <p className="text-ink-500 text-xs mt-1 truncate">{item.topic || 'بدون موضوع'}</p>
                  </div>
                  <Badge color={item.status === 'published' ? 'brand' : item.status === 'review' ? 'warning' : item.status === 'scheduled' ? 'accent' : 'neutral'}>
                    {statusLabel(item.status)}
                  </Badge>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
