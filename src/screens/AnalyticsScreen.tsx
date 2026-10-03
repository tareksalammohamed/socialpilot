import { aggregateInsights, allPages, dateInZone, hourInZone, type Insight } from '@/lib/analytics';
import { enqueueTask } from '@/lib/tasks';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, Sparkles, RefreshCw, TrendingUp, CalendarDays } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { callAiGateway } from '@/lib/api';
import { Button, Card, EmptyState, ErrorBanner, ScreenLoader, Spinner } from '@/components/ui';
import type { Content, PublishingJob } from '@/lib/types';

type Range = 'today' | '7' | '30' | '90' | 'custom';

type RankedItem = { label: string; score: number };

const METRIC_LABELS: Record<string, string> = {
  reach: 'الوصول',
  impressions: 'الظهور',
  engagements: 'التفاعلات المتاحة',
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
  const activeLoad = useRef(0);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [range, setRange] = useState<Range>('30');
  const [customFrom, setCustomFrom] = useState(() => dateInZone(new Date().toISOString(),timezone));
  const [customTo, setCustomTo] = useState(() => dateInZone(new Date().toISOString(),timezone));
  const [insights, setInsights] = useState<Insight[]>([]);
  const [published, setPublished] = useState<PublishingJob[]>([]);
  const [content, setContent] = useState<Content[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncError,setSyncError]=useState<string|null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [aiInsight, setAiInsight] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);

  const load = useCallback(async () => {
    if (!workspace) return;
    const request = ++activeLoad.current;
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

    try {
      const [rows,jobs,contents] = await Promise.all([
        allPages<Insight>((from,to) => {
          let q=supabase.from('latest_post_insights').select('*').eq('workspace_id',workspace.id).gte('published_at',since.toISOString()).order('id').range(from,to);
          if(until) q=q.lte('published_at',until.toISOString());
          return q;
        }),
        allPages<PublishingJob>((from,to) => {
          let q=supabase.from('latest_analytics_jobs').select('*').eq('workspace_id',workspace.id).gte('published_at',since.toISOString()).order('id').range(from,to);
          if(until) q=q.lte('published_at',until.toISOString());
          return q;
        }),
        allPages<Content>((from,to)=>supabase.from('content').select('*').eq('workspace_id',workspace.id).order('id').range(from,to)),
      ]);
      if(request!==activeLoad.current) return;
      setInsights(rows);setPublished(jobs);setContent(contents);
    } catch(err) {
      if(request!==activeLoad.current) return;
      setError(err instanceof Error ? err.message : 'فشل تحميل التحليلات');
    }
    setAiInsight(null);
    setLoading(false);
  }, [workspace, range, customFrom, customTo]);

  useEffect(() => { void load(); }, [load]);

  const summary = useMemo(()=>aggregateInsights(insights),[insights]);
  const totals = summary.totals;
  const displayedMetric=(metric:string):number|null=>totals[metric]??null;
  const contentById=useMemo(()=>new Map(content.map(item=>[item.id,item])),[content]);
  const measuredPosts=summary.posts.filter(post=>post.engagement!==null);
  const rankedPosts=measuredPosts.map(post=>({label:`${contentById.get(post.contentId??'')?.title??'منشور'} · ${post.platform}`,score:post.engagement!})).sort((a,b)=>b.score-a.score);
  const bestPlatform=averageRank(measuredPosts.map(post=>({label:post.platform,score:post.engagement!})));
  const bestContentType=averageRank(measuredPosts.map(post=>({label:contentTypeOf(contentById.get(post.contentId??'')),score:post.engagement!})).filter(item=>item.label!=='غير محدد'));
  const bestPostingTime=averageRank(measuredPosts.map(post=>({label:hourInZone(post.publishedAt,timezone),score:post.engagement!})));
  const byDay:Record<string,number>={};
  for(const post of measuredPosts){const day=dateInZone(post.publishedAt,timezone);byDay[day]=(byDay[day]??0)+post.engagement!;}
  const trend=Object.entries(byDay).sort(([a],[b])=>a.localeCompare(b));
  const trendMax = Math.max(...trend.map(([, score]) => score), 1);

  useEffect(()=>{
    if(!workspace) return;
    let cancelled=false;
    let previous='';
    const check=async()=>{
      const {data}=await supabase.from('assistant_tasks').select('id,status,result,error,updated_at').eq('workspace_id',workspace.id).eq('task_kind','analytics').order('created_at',{ascending:false}).limit(1).maybeSingle();
      if(cancelled||!data) return;
      const active=['queued','running'].includes(data.status);setSyncing(active);
      const signature=`${data.id}:${data.status}:${data.updated_at}`;
      if(signature!==previous){
        previous=signature;
        if(active) setSyncMessage('مزامنة المؤشرات تعمل على السيرفر وتكمل لو قفلت الصفحة.');
        else if(data.status==='failed') setSyncMessage(`تعذرت المزامنة: ${data.error??'راجع ربط الحسابات'}`);
        else{
          const result=data.result??{};
          const count=Array.isArray(result.errors)?result.errors.length:0;
          setSyncMessage(`آخر مزامنة: ${Number(result.synced??0)} قراءة؛ ${count} مشكلة. ${count?'راجع التفاصيل أدناه.':''}`);
          const details=(result.errors??[]) as {platform:string;error:string}[];

          const unsupported=(result.unsupportedPlatforms??[]) as string[];
          if(unsupported.length) setSyncMessage(prev=>`${prev} مؤشرات غير متاحة لـ: ${unsupported.join('، ')}.`);
          await load();
          if(!cancelled)setSyncError(details.length?[...new Set(details.map(item=>item.platform==='linkedin'&&item.error.includes('(403')?'لينكدإن رفض قراءة التحليلات: يحتاج التطبيق صلاحية r_member_postAnalytics، ثم إعادة ربط الحساب بعد إتاحة الصلاحية.':`${item.platform}: ${item.error}`))].join(' | '):null);
        }
      }
    };
    void check();const timer=setInterval(()=>{if(document.visibilityState==='visible')void check();},5000);
    return()=>{cancelled=true;clearInterval(timer);};
  },[workspace,load]);

  async function syncInsights(){
    if(!workspace) return;
    setSyncing(true);setError(null);setSyncError(null);
    try{await enqueueTask(workspace.id,'analytics',{message:'تحديث مؤشرات المنصات'});setSyncMessage('تم إرسال المزامنة؛ التنفيذ يكمل على السيرفر.');}
    catch(err){setError(err instanceof Error?err.message:'تعذر إرسال المزامنة');setSyncing(false);}
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
          measurement_basis: "Lifetime counters for posts published in the selected range; latest snapshot only. Reach is summed per-post reach, not deduplicated people; comparisons are descriptive and do not measure daily growth.",
          measured_posts: summary.measuredPosts,
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
              <p className="text-ink-400 text-sm mt-2">أداء المنشورات المنشورة خلال الفترة، من تاريخ نشرها حتى آخر تحديث متاح من المنصة.</p>
            </div>
          </div>
          <Button variant="secondary" size="sm" onClick={syncInsights} disabled={syncing}>
            <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} /> مزامنة
          </Button>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-5">
          <div className="metric-tile"><p className="metric-value">{published.length}</p><p className="metric-label">منشورات منشورة</p></div>
          <div className="metric-tile"><p className="metric-value">{summary.measuredPosts} / {published.length}</p><p className="metric-label">منشورات لها قياس تفاعل</p></div>
          <div className="metric-tile"><p className="metric-value">{formatScore(displayedMetric('reach'))}</p><p className="metric-label">مجموع وصول المنشورات</p></div>
          <div className="metric-tile"><p className="metric-value">{formatScore(displayedMetric('engagements'))}</p><p className="metric-label">التفاعلات المتاحة</p></div>
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
      {(error||syncError) && <div className="mb-4"><ErrorBanner message={error||syncError||''} /></div>}
      {syncMessage && <div className="mb-4 rounded-xl border border-accent-500/30 bg-accent-500/10 px-4 py-3 text-sm text-accent-300">{syncMessage}</div>}

      {insights.length === 0 ? (
        published.length > 0
          ? <EmptyState icon={<BarChart3 size={28} />} title="المؤشرات غير متاحة بعد" subtitle={`لديك ${published.length.toLocaleString('ar-EG')} منشور في هذه الفترة بدون قراءات متاحة. شغّل المزامنة وراجع أي رسالة صلاحيات.`} />
          : <EmptyState icon={<BarChart3 size={28} />} title="لا توجد بيانات بعد" subtitle="انشر محتوى ثم شغّل مزامنة التحليلات من الحسابات المتصلة." />
      ) : <>
        <div className="grid grid-cols-2 gap-3 mb-5">{['reach', 'impressions', 'engagements', 'clicks'].map((metric) => { const value = displayedMetric(metric); return <Card key={metric} className="surface-card"><p className="text-ink-500 text-xs">{METRIC_LABELS[metric]}</p><p className="text-2xl font-bold text-ink-50 mt-1">{value === null ? 'N/A' : Math.round(value).toLocaleString('ar-EG')}</p></Card>; })}</div>

        <div className="grid grid-cols-2 gap-3 mb-5">
          <RankCard title="أفضل منشور" item={rankedPosts[0] ?? null} />
          <RankCard title="أضعف منشور" item={rankedPosts.length > 0 ? rankedPosts[rankedPosts.length - 1] : null} />
          <RankCard title="أعلى متوسط تفاعل حسب المنصة" item={bestPlatform} />
          <RankCard title="أعلى متوسط حسب النوع" item={bestContentType} />
          <RankCard title="أعلى متوسط حسب ساعة النشر" item={bestPostingTime} />
          <Card className="surface-card"><p className="text-ink-500 text-xs">منشورات منشورة</p><p className="text-xl font-bold text-ink-50 mt-1">{published.length.toLocaleString('ar-EG')}</p></Card>
        </div>

        <Card className="surface-card mb-5"><div className="flex items-center gap-2 mb-3"><TrendingUp size={17} className="text-accent-400" /><p className="text-ink-200 text-sm font-medium">التفاعلات الحالية حسب يوم النشر</p></div>
          {trend.length === 0 ? <p className="text-ink-500 text-xs">لا توجد بيانات تفاعل كافية لرسم الاتجاه.</p> : <div className="flex items-end gap-1 h-28">{trend.map(([day, score]) => <div key={day} className="flex-1 min-w-0 h-full flex flex-col justify-end items-center gap-1"><div title={`${day}: ${formatScore(score)}`} className="w-full max-w-5 rounded-t bg-brand-500/80" style={{ height: `${(score / trendMax) * 100}%` }} /><span className="text-[9px] text-ink-600 rotate-[-45deg] origin-top-left mt-2">{day.slice(5)}</span></div>)}</div>}
        </Card>

        <Card className="surface-card"><div className="flex items-center gap-2 mb-3"><Sparkles size={17} className="text-brand-400" /><p className="text-ink-200 text-sm font-medium">AI Insights والاستراتيجية القادمة</p></div>{aiInsight ? <p className="text-ink-100 text-sm leading-relaxed whitespace-pre-wrap">{aiInsight}</p> : <Button size="sm" onClick={generateAiInsight} disabled={aiLoading}>{aiLoading ? <><Spinner size={14} /> جارٍ التحليل...</> : 'حلل الأداء واقترح الخطة القادمة'}</Button>}</Card>
      </>}
      <p className="text-ink-600 text-[11px] mt-5">آخر قراءة متاحة: {summary.lastFetched ? new Date(summary.lastFetched).toLocaleString('ar-EG') : 'لا توجد'}. أقدم قراءة معروضة: {summary.oldestFetched ? new Date(summary.oldestFetched).toLocaleString('ar-EG') : 'لا توجد'}. البيانات غير المتاحة تظهر N/A. مجموع الوصول قد يشمل نفس الشخص في أكثر من منشور. ساعة النشر حسب توقيت جهازك ({timezone})، والمقارنة وصفية ولا تضمن أفضل موعد مستقبلي.</p>
    </div>
  );
}

function RankCard({ title, item }: { title: string; item: RankedItem | null }) {
  return <Card className="surface-card"><p className="text-ink-500 text-xs">{title}</p><p className="text-ink-100 text-sm font-medium mt-1 truncate">{item?.label ?? 'N/A'}</p><p className="text-ink-500 text-xs mt-1">{item ? formatScore(item.score) : 'N/A'} تفاعل</p></Card>;
}

function averageRank(items:RankedItem[]):RankedItem|null{
 const groups=new Map<string,{total:number;count:number}>();
 for(const item of items){const group=groups.get(item.label)??{total:0,count:0};group.total+=item.score;group.count++;groups.set(item.label,group);}
 return [...groups].map(([label,group])=>({label:`${label} (${group.count} منشور)`,score:group.total/group.count})).sort((a,b)=>b.score-a.score)[0]??null;
}
