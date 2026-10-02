import { useCallback, useEffect, useMemo, useState } from 'react';
import { BarChart3, Sparkles, RefreshCw, TrendingUp, CalendarDays } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { callAiGateway } from '@/lib/api';
import { Button, Card, EmptyState, ErrorBanner, ScreenLoader, Spinner } from '@/components/ui';
import type { Content, PublishingJob } from '@/lib/types';

type Insight = {
  metric: string;
  value: number;
  timestamp: string;
  platform: string;
  external_post_id: string | null;
  content_id: string | null;
  variant_id: string | null;
  fetched_at: string;
};

type Range = 'today' | '7' | '30' | '90' | 'custom';

type RankedItem = { label: string; score: number };

const METRIC_LABELS: Record<string, string> = {
  reach: 'الوصول',
  impressions: 'الظهور',
  engagements: 'التفاعلات',
  likes: 'الإعجابات',
  reactions: 'التفاعلات العاطفية',
  comments: 'التعليقات',
  shares: 'المشاركات',
  saved: 'الحفظ',
  total_interactions: 'إجمالي التفاعلات',
  views: 'المشاهدات',
  clicks: 'النقرات',
  followers: 'المتابعون',
  follower_growth: 'نمو المتابعين',
  video_views: 'مشاهدات الفيديو',
};

const ENGAGEMENT_METRICS = new Set(['engagements', 'likes', 'reactions', 'comments', 'shares', 'saved', 'total_interactions', 'clicks']);

function engagementValue(row: Insight): number {
  return ENGAGEMENT_METRICS.has(row.metric) ? Number(row.value ?? 0) : 0;
}

function formatScore(score: number | null): string {
  return score === null ? 'N/A' : Math.round(score).toLocaleString('ar-EG');
}

function contentTypeOf(item: Content | undefined): string {
  if (!item) return 'غير محدد';
  const meta = item.ai_meta ?? {};
  const raw = meta.content_type ?? meta.contentType ?? meta.type;
  return typeof raw === 'string' && raw.trim() ? raw : 'غير محدد';
}

export function AnalyticsScreen() {
  const { workspace } = useAuth();
  const [range, setRange] = useState<Range>('30');
  const [customFrom, setCustomFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [customTo, setCustomTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [insights, setInsights] = useState<Insight[]>([]);
  const [published, setPublished] = useState<PublishingJob[]>([]);
  const [content, setContent] = useState<Content[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [aiInsight, setAiInsight] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);

  const load = useCallback(async () => {
    if (!workspace) return;
    setLoading(true);
    setError(null);

    const since = new Date();
    let until: Date | null = null;
    if (range === 'today') {
      since.setHours(0, 0, 0, 0);
    } else if (range === 'custom') {
      const from = new Date(`${customFrom}T00:00:00`);
      const to = new Date(`${customTo}T23:59:59.999`);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from > to) {
        setError('حدد نطاقًا زمنيًا صحيحًا قبل تحميل التحليلات.');
        setLoading(false);
        return;
      }
      since.setTime(from.getTime());
      until = to;
    } else {
      since.setDate(since.getDate() - Number(range));
    }

    let insightQuery = supabase
      .from('post_insights')
      .select('metric,value,timestamp,platform,external_post_id,content_id,variant_id,fetched_at')
      .eq('workspace_id', workspace.id)
      .gte('timestamp', since.toISOString())
      .order('timestamp', { ascending: false })
      .limit(1000);
    if (until) insightQuery = insightQuery.lte('timestamp', until.toISOString());

    let jobsQuery = supabase.from('publishing_jobs').select('*').eq('workspace_id', workspace.id).eq('status', 'succeeded').gte('completed_at', since.toISOString()).limit(500);
    if (until) jobsQuery = jobsQuery.lte('completed_at', until.toISOString());

    const [insightRes, jobsRes, contentRes] = await Promise.all([
      insightQuery,
      jobsQuery,
      supabase.from('content').select('*').eq('workspace_id', workspace.id).order('created_at', { ascending: false }).limit(500),
    ]);
    if (insightRes.error || jobsRes.error || contentRes.error) setError((insightRes.error ?? jobsRes.error ?? contentRes.error)?.message ?? 'فشل تحميل التحليلات');
    setInsights((insightRes.data as Insight[]) ?? []);
    setPublished((jobsRes.data as PublishingJob[]) ?? []);
    setContent((contentRes.data as Content[]) ?? []);
    setAiInsight(null);
    setLoading(false);
  }, [workspace, range, customFrom, customTo]);

  useEffect(() => { void load(); }, [load]);

  const totals = useMemo(() => insights.reduce<Record<string, number>>((acc, row) => {
    acc[row.metric] = (acc[row.metric] ?? 0) + Number(row.value ?? 0);
    return acc;
  }, {}), [insights]);

  const metricRows = useMemo(() => insights.reduce<Record<string, Insight[]>>((acc, row) => {
    (acc[row.metric] ??= []).push(row);
    return acc;
  }, {}), [insights]);

  function displayedMetric(metric: string): number | null {
    const rows = metricRows[metric] ?? [];
    if (metric === 'engagements' && rows.length === 0) {
      const componentRows = insights.filter((row) => ENGAGEMENT_METRICS.has(row.metric) && row.metric !== 'engagements');
      return componentRows.length > 0 ? componentRows.reduce((sum, row) => sum + Number(row.value ?? 0), 0) : null;
    }
    return rows.length > 0 ? rows.reduce((sum, row) => sum + Number(row.value ?? 0), 0) : null;
  }

  const contentById = useMemo(() => new Map(content.map((item) => [item.id, item])), [content]);

  const rankedPosts = useMemo(() => {
    const scores = insights.reduce<Record<string, number>>((acc, row) => {
      const key = row.content_id ?? row.external_post_id ?? `${row.platform}:${row.timestamp}`;
      acc[key] = (acc[key] ?? 0) + engagementValue(row);
      return acc;
    }, {});
    return Object.entries(scores)
      .map(([key, score]) => ({ label: contentById.get(key)?.title ?? key, score }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);
  }, [insights, contentById]);

  const bestPlatform = useMemo(() => {
    const scores = insights.reduce<Record<string, number>>((acc, row) => {
      acc[row.platform] = (acc[row.platform] ?? 0) + engagementValue(row);
      return acc;
    }, {});
    return Object.entries(scores)
      .filter(([, score]) => score > 0)
      .map(([label, score]) => ({ label, score }))
      .sort((a, b) => b.score - a.score)[0] ?? null;
  }, [insights]);

  const bestContentType = useMemo(() => {
    const scores = insights.reduce<Record<string, number>>((acc, row) => {
      const type = contentTypeOf(contentById.get(row.content_id ?? ''));
      acc[type] = (acc[type] ?? 0) + engagementValue(row);
      return acc;
    }, {});
    return Object.entries(scores)
      .filter(([, score]) => score > 0)
      .map(([label, score]) => ({ label, score }))
      .sort((a, b) => b.score - a.score)[0] ?? null;
  }, [insights, contentById]);

  const bestPostingTime = useMemo(() => {
    const scores = insights.reduce<Record<string, number>>((acc, row) => {
      const hour = new Date(row.timestamp).getHours();
      const label = `${String(hour).padStart(2, '0')}:00`;
      acc[label] = (acc[label] ?? 0) + engagementValue(row);
      return acc;
    }, {});
    return Object.entries(scores)
      .filter(([, score]) => score > 0)
      .map(([label, score]) => ({ label, score }))
      .sort((a, b) => b.score - a.score)[0] ?? null;
  }, [insights]);

  const trend = useMemo(() => {
    const byDay = insights.reduce<Record<string, number>>((acc, row) => {
      const day = new Date(row.timestamp).toISOString().slice(0, 10);
      acc[day] = (acc[day] ?? 0) + engagementValue(row);
      return acc;
    }, {});
    return Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b));
  }, [insights]);

  const trendMax = Math.max(...trend.map(([, score]) => score), 1);

  async function syncInsights() {
    if (!workspace) return;
    setSyncing(true);
    setError(null);
    setSyncMessage(null);
    try {
      const { data: session } = await supabase.auth.getSession();
      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/analytics-sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.session?.access_token ?? ''}`, apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string },
        body: JSON.stringify({ workspaceId: workspace.id }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error ?? 'فشل مزامنة التحليلات');
      await load();
      const syncNotes: string[] = [];
      if (Array.isArray(body.errors) && body.errors.length > 0) syncNotes.push(`فشل ${body.errors.length} من ${body.attempted ?? body.errors.length} مهمة`);
      if (Array.isArray(body.unsupportedPlatforms) && body.unsupportedPlatforms.length > 0) syncNotes.push(`لا توجد مزامنة metrics بعد لـ: ${body.unsupportedPlatforms.join('، ')}`);
      if (syncNotes.length > 0) {
        setError(`اكتملت المزامنة جزئيًا: ${syncNotes.join('؛ ')}. البيانات السابقة محفوظة.`);
      } else if (Number(body.attempted ?? 0) === 0) {
        setSyncMessage('تمت المزامنة بنجاح. لا توجد منشورات منشورة قابلة لجلب Metrics بعد.');
      } else {
        setSyncMessage(`تمت المزامنة بنجاح: تمت معالجة ${Number(body.attempted ?? 0).toLocaleString('ar-EG')} مهمة وحُفظت ${Number(body.synced ?? 0).toLocaleString('ar-EG')} قراءة Metric.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'فشل مزامنة التحليلات');
    } finally {
      setSyncing(false);
    }
  }

  async function generateAiInsight() {
    if (!workspace || insights.length === 0) return;
    setAiLoading(true);
    setError(null);
    try {
      const response = await callAiGateway({
        intent: 'analyze_performance',
        workspaceId: workspace.id,
        message: 'حلل الأداء الحقيقي واقترح استراتيجية المحتوى القادمة',
        context: {
          range_days: range === 'today' ? 1 : range === 'custom' ? `${customFrom} إلى ${customTo}` : Number(range),
          totals,
          best_platform: bestPlatform?.label ?? null,
          best_post: rankedPosts[0]?.label ?? null,
          best_content_type: bestContentType?.label ?? null,
          best_posting_time: bestPostingTime?.label ?? null,
          trend,
          published_posts: published.length,
          performance: totals,
        },
      });
      setAiInsight((response.result as { advice?: string }).advice ?? 'لم يتم إرجاع تحليل نصي.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'فشل تحليل الأداء');
    } finally {
      setAiLoading(false);
    }
  }

  if (loading) return <ScreenLoader />;

  return (
    <div className="page-shell safe-top pb-28 max-w-6xl">
      <section className="surface-hero mb-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="status-orb"><BarChart3 size={20} className="text-brand-300" /></div>
            <div>
              <p className="eyebrow">PERFORMANCE INTELLIGENCE</p>
              <h1 className="text-2xl font-bold text-ink-50 mt-1">التحليلات والأداء</h1>
              <p className="text-ink-400 text-sm mt-2">Metrics حقيقية من المنصات، ترتيب الأداء، واتجاهات تساعد الـAI يبني الخطة القادمة.</p>
            </div>
          </div>
          <Button variant="secondary" size="sm" onClick={syncInsights} disabled={syncing}>
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} /> مزامنة
          </Button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-5">
          <div className="metric-tile"><p className="metric-value">{published.length}</p><p className="metric-label">منشورات منشورة</p></div>
          <div className="metric-tile"><p className="metric-value">{insights.length}</p><p className="metric-label">قراءات Metrics</p></div>
          <div className="metric-tile"><p className="metric-value">{formatScore(displayedMetric('reach'))}</p><p className="metric-label">إجمالي الوصول</p></div>
          <div className="metric-tile"><p className="metric-value">{formatScore(displayedMetric('engagements'))}</p><p className="metric-label">التفاعلات</p></div>
        </div>
      </section>

      <div className="flex flex-wrap gap-2 mb-3 rounded-xl border border-ink-800 bg-ink-900/60 p-2">
        {([['today', 'اليوم'], ['7', '7 أيام'], ['30', '30 يومًا'], ['90', '90 يومًا'], ['custom', 'مخصص']] as Array<[Range, string]>).map(([value, label]) => (
          <button key={value} onClick={() => setRange(value)} className={`px-3 py-2 rounded-lg text-xs ${range === value ? 'bg-brand-500 text-ink-950' : 'bg-ink-900 text-ink-400'}`}>{label}</button>
        ))}
      </div>
      {range === 'custom' && (
        <Card className="surface-card mb-4">
          <div className="flex items-center gap-2 mb-3"><CalendarDays size={15} className="text-brand-400" /><p className="text-ink-300 text-xs">الفترة المخصصة</p></div>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-ink-500 text-xs">من<input type="date" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-900 px-2 py-2 text-xs text-ink-200" /></label>
            <label className="text-ink-500 text-xs">إلى<input type="date" value={customTo} onChange={(event) => setCustomTo(event.target.value)} className="mt-1 w-full rounded-lg border border-ink-700 bg-ink-900 px-2 py-2 text-xs text-ink-200" /></label>
          </div>
        </Card>
      )}
      {error && <div className="mb-4"><ErrorBanner message={error} /></div>}
      {syncMessage && <div className="mb-4 rounded-xl border border-accent-500/30 bg-accent-500/10 px-4 py-3 text-sm text-accent-300">{syncMessage}</div>}

      {insights.length === 0 ? (
        published.length > 0
          ? <EmptyState icon={<BarChart3 size={28} />} title="المزامنة معلّقة" subtitle={`لديك ${published.length.toLocaleString('ar-EG')} منشور منشور في هذه الفترة بدون Metrics بعد. اضغط مزامنة لجلبها من المنصات.`} />
          : <EmptyState icon={<BarChart3 size={28} />} title="لا توجد بيانات بعد" subtitle="انشر محتوى ثم شغّل مزامنة التحليلات من الحسابات المتصلة." />
      ) : <>
        <div className="grid grid-cols-2 gap-3 mb-5">{['reach', 'impressions', 'engagements', 'clicks'].map((metric) => { const value = displayedMetric(metric); return <Card key={metric} className="surface-card"><p className="text-ink-500 text-xs">{METRIC_LABELS[metric]}</p><p className="text-2xl font-bold text-ink-50 mt-1">{value === null ? 'N/A' : Math.round(value).toLocaleString('ar-EG')}</p></Card>; })}</div>

        <div className="grid grid-cols-2 gap-3 mb-5">
          <RankCard title="أفضل منشور" item={rankedPosts[0] ?? null} />
          <RankCard title="أضعف منشور" item={rankedPosts.length > 0 ? rankedPosts[rankedPosts.length - 1] : null} />
          <RankCard title="أفضل منصة" item={bestPlatform} />
          <RankCard title="أفضل نوع محتوى" item={bestContentType} />
          <RankCard title="أفضل وقت نشر" item={bestPostingTime} />
          <Card className="surface-card"><p className="text-ink-500 text-xs">منشورات منشورة</p><p className="text-xl font-bold text-ink-50 mt-1">{published.length.toLocaleString('ar-EG')}</p></Card>
        </div>

        <Card className="surface-card mb-5"><div className="flex items-center gap-2 mb-3"><TrendingUp size={17} className="text-accent-400" /><p className="text-ink-200 text-sm font-medium">اتجاه التفاعلات</p></div>
          {trend.length === 0 ? <p className="text-ink-500 text-xs">لا توجد بيانات تفاعل كافية لرسم الاتجاه.</p> : <div className="flex items-end gap-1 h-28">{trend.map(([day, score]) => <div key={day} className="flex-1 min-w-0 h-full flex flex-col justify-end items-center gap-1"><div title={`${day}: ${formatScore(score)}`} className="w-full max-w-5 rounded-t bg-brand-500/80" style={{ height: `${Math.max(6, (score / trendMax) * 100)}%` }} /><span className="text-[9px] text-ink-600 rotate-[-45deg] origin-top-left mt-2">{day.slice(5)}</span></div>)}</div>}
        </Card>

        <Card className="surface-card"><div className="flex items-center gap-2 mb-3"><Sparkles size={17} className="text-brand-400" /><p className="text-ink-200 text-sm font-medium">AI Insights والاستراتيجية القادمة</p></div>{aiInsight ? <p className="text-ink-100 text-sm leading-relaxed whitespace-pre-wrap">{aiInsight}</p> : <Button size="sm" onClick={generateAiInsight} disabled={aiLoading}>{aiLoading ? <><Spinner size={14} /> جارٍ التحليل...</> : 'حلل الأداء واقترح الخطة القادمة'}</Button>}</Card>
      </>}
      <p className="text-ink-600 text-[11px] mt-5">عدد المحتوى المسجل في الفترة: {content.length}. أي Metric غير متاح من المنصة يظهر كـ N/A ولا يتم اختلاق قيم.</p>
    </div>
  );
}

function RankCard({ title, item }: { title: string; item: RankedItem | null }) {
  return <Card className="surface-card"><p className="text-ink-500 text-xs">{title}</p><p className="text-ink-100 text-sm font-medium mt-1 truncate">{item?.label ?? 'N/A'}</p><p className="text-ink-500 text-xs mt-1">{item ? formatScore(item.score) : 'N/A'} تفاعل</p></Card>;
}
