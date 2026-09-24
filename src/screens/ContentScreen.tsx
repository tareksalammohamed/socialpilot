import { useEffect, useState } from 'react';
import { FileText, Calendar as CalendarIcon, ChevronLeft, ChevronRight, ChevronDown, Send, Check, ExternalLink, Pencil, Save, X, Sparkles, Image as ImageIcon, Trash2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/lib/auth';
import { publishVariant, callAgentTurn, callApprovedTools } from '@/lib/api';
import { Card, ScreenLoader, EmptyState, Badge, Button, ErrorBanner, Spinner } from '@/components/ui';
import { PLATFORM_META } from '@/lib/constants';
import { PlatformPreview } from '@/components/PlatformPreview';
import type { Content, CalendarItem, ContentStatus, ContentVariant, SocialAccount, SocialPlatform, MediaItem } from '@/lib/types';

const MAX_MEDIA_BYTES = 10 * 1024 * 1024; // 10MB — section 10: file size validation
const ACCEPTED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']; // images only for this phase

type View = 'list' | 'calendar';

const STATUS_LABELS: Record<ContentStatus, string> = {
  idea: 'فكرة',
  draft: 'مسودة',
  review: 'مراجعة',
  approved: 'موافق عليه',
  scheduled: 'مجدول',
  published: 'منشور',
  rejected: 'مرفوض',
};

const STATUS_COLORS: Record<ContentStatus, 'neutral' | 'brand' | 'warning' | 'accent' | 'danger'> = {
  idea: 'neutral',
  draft: 'neutral',
  review: 'warning',
  approved: 'brand',
  scheduled: 'accent',
  published: 'brand',
  rejected: 'danger',
};

// Keep this in sync with SUPPORTED_PLATFORMS in supabase/functions/social-publish.
const PUBLISHABLE_PLATFORMS = new Set<SocialPlatform>(['telegram', 'x', 'facebook', 'instagram', 'linkedin']);

type PublishOutcome = { ok: boolean; message: string; url?: string | null };

export function ContentScreen() {
  const { workspace } = useAuth();
  const [view, setView] = useState<View>('list');
  const [content, setContent] = useState<Content[]>([]);
  const [calendar, setCalendar] = useState<CalendarItem[]>([]);
  const [accounts, setAccounts] = useState<SocialAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [weekOffset, setWeekOffset] = useState(0);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [variantsByContent, setVariantsByContent] = useState<Record<string, ContentVariant[]>>({});
  const [variantsLoading, setVariantsLoading] = useState<string | null>(null);
  const [publishingId, setPublishingId] = useState<string | null>(null);
  const [publishResults, setPublishResults] = useState<Record<string, PublishOutcome>>({});
  const [editingVariantId, setEditingVariantId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const [savingVariantId, setSavingVariantId] = useState<string | null>(null);
  const [editResults, setEditResults] = useState<Record<string, string>>({});
  const [aiInstructionByVariant, setAiInstructionByVariant] = useState<Record<string, string>>({});
  const [aiEditingVariantId, setAiEditingVariantId] = useState<string | null>(null);
  const [aiEditResults, setAiEditResults] = useState<Record<string, string>>({});
  const [mediaCache, setMediaCache] = useState<Record<string, MediaItem>>({});
  const [mediaUploadingId, setMediaUploadingId] = useState<string | null>(null);
  const [mediaErrors, setMediaErrors] = useState<Record<string, string>>({});
  const [mediaBriefLoadingId, setMediaBriefLoadingId] = useState<string | null>(null);
  const [previewVariantId, setPreviewVariantId] = useState<string | null>(null);
  const [pendingApprovalByVariant, setPendingApprovalByVariant] = useState<Record<string, { reason: string; toolCalls: { id: string; name: string; input: Record<string, unknown> }[] }>>({});
  const [approvingVariantId, setApprovingVariantId] = useState<string | null>(null);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [approvalResults, setApprovalResults] = useState<Record<string, string>>({});
  const [reschedulingId, setReschedulingId] = useState<string | null>(null);
  const [calendarMessage, setCalendarMessage] = useState<string | null>(null);

  useEffect(() => {
    const missingIds = Object.values(variantsByContent)
      .flat()
      .map((v) => v.media_id)
      .filter((id): id is string => !!id && !mediaCache[id]);
    if (missingIds.length === 0) return;
    (async () => {
      const { data } = await supabase.from('media').select('*').in('id', missingIds);
      if (data && data.length > 0) {
        setMediaCache((prev) => {
          const next = { ...prev };
          for (const row of data as MediaItem[]) next[row.id] = row;
          return next;
        });
      }
    })();
  }, [variantsByContent, mediaCache]);

  useEffect(() => {
    if (!workspace) return;
    (async () => {
      const [c, cal, acc] = await Promise.all([
        supabase
          .from('content')
          .select('*')
          .eq('workspace_id', workspace.id)
          .order('created_at', { ascending: false }),
        supabase
          .from('calendar_items')
          .select('*')
          .eq('workspace_id', workspace.id)
          .order('scheduled_for', { ascending: true }),
        supabase
          .from('social_accounts')
          .select('*')
          .eq('workspace_id', workspace.id),
      ]);
      const firstError = c.error ?? cal.error ?? acc.error;
      if (firstError) setLoadError(firstError.message);
      setContent((c.data as Content[]) ?? []);
      setCalendar((cal.data as CalendarItem[]) ?? []);
      setAccounts((acc.data as SocialAccount[]) ?? []);
      setLoading(false);
    })();
  }, [workspace]);

  async function toggleExpand(contentId: string) {
    if (expandedId === contentId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(contentId);
    if (variantsByContent[contentId]) return;

    setVariantsLoading(contentId);
    const { data } = await supabase
      .from('content_variants')
      .select('*')
      .eq('content_id', contentId)
      .order('platform', { ascending: true });
    setVariantsByContent((prev) => ({ ...prev, [contentId]: (data as ContentVariant[]) ?? [] }));
    setVariantsLoading(null);
  }

  function startEditingVariant(variant: ContentVariant) {
    setEditingVariantId(variant.id);
    setEditingText(variant.text);
    setEditResults((prev) => ({ ...prev, [variant.id]: '' }));
  }

  function cancelEditingVariant() {
    setEditingVariantId(null);
    setEditingText('');
  }

  async function handleSaveVariant(variant: ContentVariant) {
    if (!workspace || !editingText.trim()) return;
    setSavingVariantId(variant.id);
    setEditResults((prev) => ({ ...prev, [variant.id]: '' }));
    try {
      const nextStatus = variant.status === 'approved' ? 'review' : variant.status;
      const { error } = await supabase
        .from('content_variants')
        .update({ text: editingText.trim(), status: nextStatus, updated_at: new Date().toISOString() })
        .eq('id', variant.id)
        .eq('workspace_id', workspace.id);
      if (error) throw error;
      setVariantsByContent((prev) => ({
        ...prev,
        [variant.content_id]: (prev[variant.content_id] ?? []).map((item) => item.id === variant.id ? { ...item, text: editingText.trim(), status: nextStatus } : item),
      }));
      if (nextStatus === 'review') {
        setContent((prev) => prev.map((item) => item.id === variant.content_id && item.status === 'approved' ? { ...item, status: 'draft' } : item));
      }
      setEditResults((prev) => ({ ...prev, [variant.id]: 'تم حفظ التعديل وإرجاع النسخة للمراجعة قبل النشر.' }));
      cancelEditingVariant();
    } catch (e) {
      setEditResults((prev) => ({ ...prev, [variant.id]: e instanceof Error ? e.message : 'فشل حفظ تعديل المسودة' }));
    } finally {
      setSavingVariantId(null);
    }
  }

  async function handleAiEditVariant(variant: ContentVariant) {
    const instruction = (aiInstructionByVariant[variant.id] ?? '').trim();
    if (!workspace || !instruction) return;
    setAiEditingVariantId(variant.id);
    setAiEditResults((prev) => ({ ...prev, [variant.id]: '' }));
    try {
      const turn = await callAgentTurn({
        workspaceId: workspace.id,
        message: instruction,
        platforms: [variant.platform],
        agentContext: {
          currentRoute: 'content',
          currentContentId: variant.content_id,
          currentVariantId: variant.id,
          selectedPlatform: variant.platform,
        },
      });

      if (turn.clarifyingQuestion) {
        setAiEditResults((prev) => ({ ...prev, [variant.id]: turn.clarifyingQuestion as string }));
        return;
      }

      if (turn.pendingApproval) {
        setPendingApprovalByVariant((prev) => ({ ...prev, [variant.id]: turn.pendingApproval! }));
        setAiEditResults((prev) => ({ ...prev, [variant.id]: turn.pendingApproval!.reason }));
        return;
      }

      const succeeded = turn.toolResults.find((r) => r.ok && r.output);
      if (!succeeded) {
        const failed = turn.toolResults.find((r) => r.error);
        setAiEditResults((prev) => ({ ...prev, [variant.id]: failed?.error ?? 'الـAI مقدرش ينفذ التعديل ده.' }));
        return;
      }

      const out = succeeded.output as { text?: string; hashtags?: string[]; cta?: string };
      const nextStatus = variant.status === 'approved' ? 'review' : variant.status;
      if (nextStatus !== variant.status) {
        // Mirror handleSaveVariant's safety rule: an AI-driven edit invalidates
        // a prior approval too — content shouldn't stay "approved" after its
        // text silently changed underneath that approval.
        await supabase.from('content_variants').update({ status: nextStatus }).eq('id', variant.id).eq('workspace_id', workspace.id);
        setContent((prev) => prev.map((item) => item.id === variant.content_id && item.status === 'approved' ? { ...item, status: 'draft' } : item));
      }
      setVariantsByContent((prev) => ({
        ...prev,
        [variant.content_id]: (prev[variant.content_id] ?? []).map((item) => item.id === variant.id
          ? { ...item, text: out.text ?? item.text, hashtags: out.hashtags ?? item.hashtags, cta: out.cta ?? item.cta, status: nextStatus }
          : item),
      }));
      setAiInstructionByVariant((prev) => ({ ...prev, [variant.id]: '' }));
      setAiEditResults((prev) => ({ ...prev, [variant.id]: 'تم تنفيذ التعديل.' }));
    } catch (e) {
      setAiEditResults((prev) => ({ ...prev, [variant.id]: e instanceof Error ? e.message : 'فشل طلب التعديل من الـAI' }));
    } finally {
      setAiEditingVariantId(null);
    }
  }

  async function handleApprovePendingTool(variant: ContentVariant) {
    const pending = pendingApprovalByVariant[variant.id];
    if (!workspace || !pending) return;
    setApprovingVariantId(variant.id);
    try {
      const { toolResults } = await callApprovedTools({
        workspaceId: workspace.id,
        toolCalls: pending.toolCalls,
        agentContext: { currentRoute: 'content', currentContentId: variant.content_id, currentVariantId: variant.id, selectedPlatform: variant.platform },
      });
      const failed = toolResults.find((r) => !r.ok);
      setAiEditResults((prev) => ({ ...prev, [variant.id]: failed ? (failed.error ?? 'فشل التنفيذ') : 'تم اعتماد وتنفيذ الإجراء.' }));
    } catch (e) {
      setAiEditResults((prev) => ({ ...prev, [variant.id]: e instanceof Error ? e.message : 'فشل تنفيذ الإجراء المعتمد' }));
    } finally {
      setApprovingVariantId(null);
      setPendingApprovalByVariant((prev) => { const next = { ...prev }; delete next[variant.id]; return next; });
    }
  }

  function handleRejectPendingTool(variant: ContentVariant) {
    setPendingApprovalByVariant((prev) => { const next = { ...prev }; delete next[variant.id]; return next; });
    setAiEditResults((prev) => ({ ...prev, [variant.id]: 'تم إلغاء الإجراء.' }));
  }

  function getMediaPublicUrl(path: string): string {
    return supabase.storage.from('media').getPublicUrl(path).data.publicUrl;
  }

  async function handleUploadMedia(variant: ContentVariant, file: File | null) {
    if (!file || !workspace) return;
    setMediaErrors((prev) => ({ ...prev, [variant.id]: '' }));

    // Section 10: file type + size validation, done before any upload call.
    if (!ACCEPTED_MEDIA_TYPES.includes(file.type)) {
      setMediaErrors((prev) => ({ ...prev, [variant.id]: 'نوع الملف غير مدعوم — استخدم JPG أو PNG أو WEBP أو GIF.' }));
      return;
    }
    if (file.size > MAX_MEDIA_BYTES) {
      setMediaErrors((prev) => ({ ...prev, [variant.id]: 'حجم الملف أكبر من 10MB.' }));
      return;
    }

    setMediaUploadingId(variant.id);
    try {
      const ext = file.name.split('.').pop() || 'jpg';
      const storagePath = `${workspace.id}/${crypto.randomUUID()}.${ext}`;
      const { error: uploadError } = await supabase.storage.from('media').upload(storagePath, file, {
        contentType: file.type,
        upsert: false,
      });
      if (uploadError) throw uploadError;

      const { data: mediaRow, error: insertError } = await supabase
        .from('media')
        .insert({
          workspace_id: workspace.id,
          content_id: variant.content_id,
          storage_path: storagePath,
          mime_type: file.type,
          size_bytes: file.size,
          kind: 'image',
          source: 'upload',
        })
        .select('*')
        .single();
      if (insertError || !mediaRow) throw insertError ?? new Error('فشل حفظ سجل الميديا');

      const { error: linkError } = await supabase
        .from('content_variants')
        .update({ media_id: mediaRow.id })
        .eq('id', variant.id);
      if (linkError) throw linkError;

      setMediaCache((prev) => ({ ...prev, [mediaRow.id]: mediaRow as MediaItem }));
      setVariantsByContent((prev) => ({
        ...prev,
        [variant.content_id]: (prev[variant.content_id] ?? []).map((item) => item.id === variant.id ? { ...item, media_id: mediaRow.id } : item),
      }));
    } catch (e) {
      setMediaErrors((prev) => ({ ...prev, [variant.id]: e instanceof Error ? e.message : 'فشل رفع الصورة' }));
    } finally {
      setMediaUploadingId(null);
    }
  }

  async function handleRemoveMedia(variant: ContentVariant) {
    if (!workspace || !variant.media_id) return;
    const { error } = await supabase.from('content_variants').update({ media_id: null }).eq('id', variant.id);
    if (error) {
      setMediaErrors((prev) => ({ ...prev, [variant.id]: error.message }));
      return;
    }
    setVariantsByContent((prev) => ({
      ...prev,
      [variant.content_id]: (prev[variant.content_id] ?? []).map((item) => item.id === variant.id ? { ...item, media_id: null } : item),
    }));
  }

  async function handleSuggestMediaBrief(variant: ContentVariant) {
    if (!workspace) return;
    setMediaBriefLoadingId(variant.id);
    try {
      const turn = await callAgentTurn({
        workspaceId: workspace.id,
        message: 'اقترح صورة مناسبة للمنشور ده',
        agentContext: { currentRoute: 'content', currentContentId: variant.content_id, selectedPlatform: variant.platform },
      });
      const succeeded = turn.toolResults.find((r) => r.ok && r.output);
      const brief = succeeded?.output?.mediaBrief as string | undefined;
      if (brief) {
        setVariantsByContent((prev) => ({
          ...prev,
          [variant.content_id]: (prev[variant.content_id] ?? []).map((item) => item.id === variant.id
            ? { ...item, media_brief: { suggestion: brief } }
            : item),
        }));
      }
    } catch {
      // Non-critical — the suggestion is a nice-to-have, fail silently in the UI beyond the missing suggestion.
    } finally {
      setMediaBriefLoadingId(null);
    }
  }

  async function handleApprove(variant: ContentVariant) {
    if (!workspace) return;
    setApprovingId(variant.id);
    try {
      const { error } = await supabase.rpc('approve_content_variant', {
        p_workspace_id: workspace.id,
        p_variant_id: variant.id,
        p_scheduled_for: variant.scheduled_at ?? null,
      });
      if (error) throw error;
      setApprovalResults((prev) => ({ ...prev, [variant.id]: 'تمت الموافقة وربط المحتوى بالتقويم ومهمة النشر' }));
      setVariantsByContent((prev) => ({
        ...prev,
        [variant.content_id]: (prev[variant.content_id] ?? []).map((item) => item.id === variant.id ? { ...item, status: 'approved' } : item),
      }));
      setContent((prev) => prev.map((item) => item.id === variant.content_id ? { ...item, status: 'scheduled' } : item));
      const { data } = await supabase.from('calendar_items').select('*').eq('workspace_id', workspace.id).order('scheduled_for', { ascending: true });
      setCalendar((data as CalendarItem[]) ?? []);
    } catch (e) {
      setApprovalResults((prev) => ({ ...prev, [variant.id]: e instanceof Error ? e.message : 'فشلت الموافقة' }));
    } finally {
      setApprovingId(null);
    }
  }

  async function handleReschedule(item: CalendarItem, value: string) {
    if (!workspace || !value) return;
    setReschedulingId(item.id);
    setCalendarMessage(null);
    try {
      const scheduledFor = new Date(value).toISOString();
      const { error } = await supabase.rpc('reschedule_calendar_item', {
        p_workspace_id: workspace.id,
        p_calendar_item_id: item.id,
        p_scheduled_for: scheduledFor,
      });
      if (error) throw error;
      setCalendar((prev) => prev.map((entry) => entry.id === item.id ? { ...entry, scheduled_for: scheduledFor, status: 'scheduled' } : entry));
      setContent((prev) => prev.map((entry) => entry.id === item.content_id ? { ...entry, scheduled_at: scheduledFor, status: 'scheduled' } : entry));
      setCalendarMessage('تم تحديث الموعد ومهمة النشر المرتبطة بدون إنشاء مهمة مكررة.');
    } catch (e) {
      setCalendarMessage(e instanceof Error ? e.message : 'فشل تعديل موعد النشر');
    } finally {
      setReschedulingId(null);
    }
  }

  async function handlePublish(variant: ContentVariant) {
    if (!workspace) return;
    setPublishingId(variant.id);
    setPublishResults((prev) => {
      const next = { ...prev };
      delete next[variant.id];
      return next;
    });
    try {
      const linkedCalendarItem = calendar.find((item) => item.variant_id === variant.id);
      const res = await publishVariant({ workspaceId: workspace.id, variantId: variant.id, calendarItemId: linkedCalendarItem?.id });
      setPublishResults((prev) => ({
        ...prev,
        [variant.id]: {
          ok: true,
          message: res.alreadyPublished ? 'منشور بالفعل' : 'تم النشر بنجاح',
          url: res.url ?? null,
        },
      }));
      setContent((prev) => prev.map((c) => (c.id === variant.content_id ? { ...c, status: 'published' } : c)));
    } catch (e) {
      setPublishResults((prev) => ({
        ...prev,
        [variant.id]: { ok: false, message: e instanceof Error ? e.message : 'فشل النشر' },
      }));
    } finally {
      setPublishingId(null);
    }
  }

  if (loading) return <ScreenLoader />;

  return (
    <div className="px-5 py-6 safe-top">
      {/* Tab toggle */}
      <div className="flex bg-ink-900 rounded-xl p-1 mb-5">
        <button
          onClick={() => setView('list')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm transition-all ${
            view === 'list' ? 'bg-ink-700 text-ink-50' : 'text-ink-400'
          }`}
        >
          <FileText size={16} /> المحتوى
        </button>
        <button
          onClick={() => setView('calendar')}
          className={`flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm transition-all ${
            view === 'calendar' ? 'bg-ink-700 text-ink-50' : 'text-ink-400'
          }`}
        >
          <CalendarIcon size={16} /> التقويم
        </button>
      </div>

      {loadError && <div className="mb-4"><ErrorBanner message={loadError} /></div>}
      {calendarMessage && <div className="mb-4"><ErrorBanner message={calendarMessage} /></div>}

      {view === 'list' ? (
        content.length === 0 ? (
          <EmptyState
            icon={<FileText size={28} />}
            title="لا يوجد محتوى بعد"
            subtitle="استخدم تبويب إنشاء واكتب للـ AI ما تريد"
          />
        ) : (
          <div className="flex flex-col gap-2">
            {content.map((c) => {
              const isExpanded = expandedId === c.id;
              const variants = variantsByContent[c.id];
              return (
                <Card key={c.id} className="!p-0 overflow-hidden">
                  <button onClick={() => toggleExpand(c.id)} className="w-full text-right p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-ink-100 text-sm font-medium truncate">{c.title}</p>
                        {c.topic && <p className="text-ink-500 text-xs mt-1 truncate">{c.topic}</p>}
                        <div className="flex items-center gap-2 mt-2">
                          <Badge color={STATUS_COLORS[c.status]}>{STATUS_LABELS[c.status]}</Badge>
                          {c.platforms.length > 0 && (
                            <span className="text-ink-600 text-xs">{c.platforms.join('، ')}</span>
                          )}
                        </div>
                      </div>
                      <ChevronDown
                        size={18}
                        className={`text-ink-500 shrink-0 mt-1 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                      />
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="px-4 pb-4 pt-1 border-t border-ink-800 flex flex-col gap-3 animate-slide-up">
                      {variantsLoading === c.id ? (
                        <div className="flex justify-center py-4">
                          <Spinner className="text-brand-400" />
                        </div>
                      ) : !variants || variants.length === 0 ? (
                        <p className="text-ink-600 text-xs py-2">مفيش نسخ محفوظة لهذا المحتوى</p>
                      ) : (
                        variants.map((v) => {
                          const meta = PLATFORM_META[v.platform as SocialPlatform];
                          const Icon = meta?.icon;
                          const account = accounts.find((a) => a.platform === v.platform && a.status === 'connected');
                          const supported = PUBLISHABLE_PLATFORMS.has(v.platform as SocialPlatform);
                          const busy = publishingId === v.id;
                          const result = publishResults[v.id];
                          const isEditing = editingVariantId === v.id;
                          const canEdit = !['published', 'scheduled'].includes(c.status);

                          let disabledReason: string | null = null;
                          if (!supported) disabledReason = 'النشر التلقائي غير مدعوم لهذه المنصة بعد';
                          else if (!account) disabledReason = `مفيش حساب ${meta?.label ?? v.platform} مربوط`;

                          return (
                            <div key={v.id} className="rounded-xl bg-ink-900 border border-ink-800 p-3">
                              <div className="flex items-center justify-between gap-2 mb-2">
                                <div className="flex items-center gap-2 min-w-0">
                                  {Icon && <Icon size={16} style={{ color: meta.color }} />}
                                  <span className="text-ink-200 text-sm font-medium">{meta?.label ?? v.platform}</span>
                                </div>
                                <div className="flex items-center gap-2 shrink-0">
                                  <Button size="sm" variant="ghost" onClick={() => setPreviewVariantId(previewVariantId === v.id ? null : v.id)}>
                                    <span className="flex items-center gap-1 text-[11px]">
                                      {previewVariantId === v.id ? 'إخفاء المعاينة' : 'معاينة'}
                                    </span>
                                  </Button>
                                  {canEdit && !isEditing && (
                                    <Button size="sm" variant="ghost" onClick={() => startEditingVariant(v)}>
                                      <span className="flex items-center gap-1"><Pencil size={14} /> تعديل</span>
                                    </Button>
                                  )}
                                  {v.status !== 'approved' && (
                                    <Button
                                      size="sm"
                                      onClick={() => handleApprove(v)}
                                      disabled={approvingId === v.id || v.quality_status === 'needs_improvement' || v.quality_status === 'failed'}
                                    >
                                      {approvingId === v.id ? 'جارٍ الاعتماد...' : 'اعتماد وجدولة'}
                                    </Button>
                                  )}
                                  <Button
                                    size="sm"
                                    onClick={() => handlePublish(v)}
                                    disabled={busy || !!disabledReason}
                                  >
                                    {busy ? (
                                      '...جارٍ النشر'
                                    ) : result?.ok ? (
                                      <span className="flex items-center gap-1">
                                        <Check size={14} /> تم النشر
                                      </span>
                                    ) : (
                                      <span className="flex items-center gap-1">
                                        <Send size={14} /> نشر الآن
                                      </span>
                                    )}
                                  </Button>
                                </div>
                              </div>
                              {isEditing ? (
                                <div className="flex flex-col gap-2">
                                  <textarea
                                    value={editingText}
                                    onChange={(event) => setEditingText(event.target.value)}
                                    rows={7}
                                    dir="auto"
                                    className="w-full rounded-xl border border-brand-500/50 bg-ink-950 px-3 py-2 text-sm leading-relaxed text-ink-100 focus:outline-none"
                                    aria-label={`تعديل نسخة ${meta?.label ?? v.platform}`}
                                  />
                                  <div className="flex items-center justify-end gap-2">
                                    <Button size="sm" variant="ghost" onClick={cancelEditingVariant} disabled={savingVariantId === v.id}>
                                      <span className="flex items-center gap-1"><X size={14} /> إلغاء</span>
                                    </Button>
                                    <Button size="sm" onClick={() => handleSaveVariant(v)} disabled={savingVariantId === v.id || !editingText.trim()}>
                                      <span className="flex items-center gap-1"><Save size={14} /> {savingVariantId === v.id ? 'جارٍ الحفظ...' : 'حفظ التعديل'}</span>
                                    </Button>
                                  </div>
                                </div>
                              ) : (
                                <p className="text-ink-400 text-xs whitespace-pre-wrap leading-relaxed line-clamp-3">
                                  {v.text}
                                </p>
                              )}
                              {approvalResults[v.id] && (
                                <p className={`text-[11px] mt-2 ${approvalResults[v.id].startsWith('تمت') ? 'text-brand-400' : 'text-red-400'}`}>
                                  {approvalResults[v.id]}
                                </p>
                              )}
                              {editResults[v.id] && (
                                <p className={`text-[11px] mt-2 ${editResults[v.id].startsWith('تم حفظ') ? 'text-brand-400' : 'text-red-400'}`}>
                                  {editResults[v.id]}
                                </p>
                              )}
                              {!isEditing && (
                                <div className="mt-2 flex items-center gap-2">
                                  <input
                                    value={aiInstructionByVariant[v.id] ?? ''}
                                    onChange={(event) => setAiInstructionByVariant((prev) => ({ ...prev, [v.id]: event.target.value }))}
                                    onKeyDown={(event) => { if (event.key === 'Enter') handleAiEditVariant(v); }}
                                    dir="auto"
                                    placeholder="اطلب تعديل من الـAI (مثلاً: خلي الـHook أقوى)"
                                    className="flex-1 rounded-lg border border-ink-700 bg-ink-950 px-2.5 py-1.5 text-xs text-ink-100 focus:outline-none focus:border-brand-500/50"
                                  />
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => handleAiEditVariant(v)}
                                    disabled={aiEditingVariantId === v.id || !(aiInstructionByVariant[v.id] ?? '').trim()}
                                  >
                                    <span className="flex items-center gap-1">
                                      {aiEditingVariantId === v.id ? <Spinner size={14} /> : <Sparkles size={14} />}
                                    </span>
                                  </Button>
                                </div>
                              )}
                              {aiEditResults[v.id] && (
                                <p className={`text-[11px] mt-1 ${aiEditResults[v.id].startsWith('تم تنفيذ') ? 'text-brand-400' : 'text-ink-400'}`}>
                                  {aiEditResults[v.id]}
                                </p>
                              )}
                              {pendingApprovalByVariant[v.id] && (
                                <div className="mt-2 rounded-lg border border-yellow-700/40 bg-yellow-900/10 px-2.5 py-2">
                                  <p className="text-[11px] text-yellow-500">{pendingApprovalByVariant[v.id].reason}</p>
                                  <div className="flex gap-2 mt-1.5">
                                    <Button size="sm" onClick={() => handleApprovePendingTool(v)} disabled={approvingVariantId === v.id}>
                                      <span className="flex items-center gap-1 text-[11px]">
                                        {approvingVariantId === v.id ? <Spinner size={12} /> : <Check size={12} />} موافقة وتنفيذ
                                      </span>
                                    </Button>
                                    <Button size="sm" variant="ghost" onClick={() => handleRejectPendingTool(v)} disabled={approvingVariantId === v.id}>
                                      <span className="text-[11px]">إلغاء</span>
                                    </Button>
                                  </div>
                                </div>
                              )}
                              {/* Media System — section 10/12 */}
                              <div className="mt-3 border-t border-ink-800 pt-3">
                                {v.media_id && mediaCache[v.media_id] ? (
                                  <div className="flex items-start gap-2">
                                    <img
                                      src={getMediaPublicUrl(mediaCache[v.media_id].storage_path)}
                                      alt={mediaCache[v.media_id].alt_text ?? ''}
                                      className="w-16 h-16 rounded-lg object-cover border border-ink-700"
                                    />
                                    <div className="flex-1">
                                      <label className="text-[11px] text-brand-400 cursor-pointer">
                                        استبدال
                                        <input type="file" accept={ACCEPTED_MEDIA_TYPES.join(',')} className="hidden"
                                          onChange={(e) => handleUploadMedia(v, e.target.files?.[0] ?? null)} />
                                      </label>
                                      <button onClick={() => handleRemoveMedia(v)} className="ms-3 text-[11px] text-red-400 inline-flex items-center gap-1">
                                        <Trash2 size={11} /> إزالة
                                      </button>
                                    </div>
                                  </div>
                                ) : (
                                  <div className="flex items-center gap-2">
                                    <label className="flex items-center gap-1.5 text-[11px] text-ink-300 border border-dashed border-ink-700 rounded-lg px-2.5 py-1.5 cursor-pointer hover:border-brand-500/50">
                                      {mediaUploadingId === v.id ? <Spinner size={12} /> : <ImageIcon size={12} />}
                                      إضافة صورة
                                      <input type="file" accept={ACCEPTED_MEDIA_TYPES.join(',')} className="hidden"
                                        disabled={mediaUploadingId === v.id}
                                        onChange={(e) => handleUploadMedia(v, e.target.files?.[0] ?? null)} />
                                    </label>
                                    <Button size="sm" variant="ghost" onClick={() => handleSuggestMediaBrief(v)} disabled={mediaBriefLoadingId === v.id}>
                                      <span className="flex items-center gap-1 text-[11px]">
                                        {mediaBriefLoadingId === v.id ? <Spinner size={12} /> : <Sparkles size={12} />} اقترح صورة
                                      </span>
                                    </Button>
                                  </div>
                                )}
                                {mediaErrors[v.id] && <p className="text-[11px] text-red-400 mt-1">{mediaErrors[v.id]}</p>}
                                {!v.media_id && (v.media_brief as { suggestion?: string })?.suggestion && (
                                  <p className="text-[11px] text-ink-400 mt-1.5" dir="auto">
                                    💡 {(v.media_brief as { suggestion?: string }).suggestion}
                                  </p>
                                )}
                              </div>
                              {previewVariantId === v.id && (
                                <div className="mt-3">
                                  <PlatformPreview
                                    platform={v.platform as SocialPlatform}
                                    account={account}
                                    text={v.text}
                                    hashtags={v.hashtags}
                                    cta={v.cta}
                                    mediaUrl={v.media_id && mediaCache[v.media_id] ? getMediaPublicUrl(mediaCache[v.media_id].storage_path) : null}
                                    scheduledAt={v.scheduled_at}
                                  />
                                </div>
                              )}
                              {disabledReason && !result && (
                                <p className="text-ink-600 text-[11px] mt-2">{disabledReason}</p>
                              )}
                              {result && !result.ok && (
                                <div className="mt-2">
                                  <ErrorBanner message={result.message} />
                                </div>
                              )}
                              {result?.ok && result.url && (
                                <a
                                  href={result.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mt-2 flex items-center gap-1 text-brand-400 text-xs"
                                >
                                  <ExternalLink size={12} /> عرض المنشور
                                </a>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )
      ) : (
        <CalendarView
          items={calendar}
          content={content}
          weekOffset={weekOffset}
          setWeekOffset={setWeekOffset}
          onReschedule={handleReschedule}
          reschedulingId={reschedulingId}
        />
      )}
    </div>
  );
}

function toLocalDateTimeInput(iso: string): string {
  const date = new Date(iso);
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
}

function CalendarView({
  items,
  content,
  weekOffset,
  setWeekOffset,
  onReschedule,
  reschedulingId,
}: {
  items: CalendarItem[];
  content: Content[];
  weekOffset: number;
  setWeekOffset: (n: number) => void;
  onReschedule: (item: CalendarItem, value: string) => void;
  reschedulingId: string | null;
}) {
  const today = new Date();
  const startOfWeek = new Date(today);
  startOfWeek.setDate(today.getDate() - today.getDay() + weekOffset * 7);
  startOfWeek.setHours(0, 0, 0, 0);

  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(startOfWeek);
    d.setDate(startOfWeek.getDate() + i);
    return d;
  });

  const dayNames = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

  function itemsForDay(day: Date): CalendarItem[] {
    const start = new Date(day);
    start.setHours(0, 0, 0, 0);
    const end = new Date(day);
    end.setHours(23, 59, 59, 999);
    return items.filter((item) => {
      const d = new Date(item.scheduled_for);
      return d >= start && d <= end;
    });
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => setWeekOffset(weekOffset - 1)}
          className="p-2 rounded-lg bg-ink-900 text-ink-300 active:scale-95"
        >
          <ChevronRight size={18} />
        </button>
        <p className="text-ink-200 text-sm font-medium">
          {weekOffset === 0 ? 'هذا الأسبوع' : weekOffset === 1 ? 'الأسبوع القادم' : weekOffset === -1 ? 'الأسبوع الماضي' : `أسبوع ${weekOffset > 0 ? '+' : ''}${weekOffset}`}
        </p>
        <button
          onClick={() => setWeekOffset(weekOffset + 1)}
          className="p-2 rounded-lg bg-ink-900 text-ink-300 active:scale-95"
        >
          <ChevronLeft size={18} />
        </button>
      </div>

      {items.length === 0 ? (
        <EmptyState
          icon={<CalendarIcon size={28} />}
          title="التقويم فارغ"
          subtitle="المحتوى المجدول سيظهر هنا"
        />
      ) : (
        <div className="flex flex-col gap-3">
          {days.map((day, i) => {
            const dayItems = itemsForDay(day);
            if (dayItems.length === 0) return null;
            return (
              <div key={i}>
                <p className="text-ink-400 text-xs mb-2">
                  {dayNames[day.getDay()]} — {day.toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' })}
                </p>
                <div className="flex flex-col gap-2">
                  {dayItems.map((item) => {
                    const meta = PLATFORM_META[item.platform as keyof typeof PLATFORM_META];
                    const Icon = meta?.icon;
                    const linkedContent = content.find((entry) => entry.id === item.content_id);
                    const isLocked = ['published', 'publishing', 'cancelled'].includes(item.status);
                    return (
                      <Card key={item.id}>
                        <div className="flex items-start gap-3">
                          {Icon && <Icon size={18} style={{ color: meta.color }} />}
                          <div className="flex-1 min-w-0">
                            <p className="text-ink-100 text-sm font-medium truncate">{linkedContent?.title ?? 'محتوى مجدول'}</p>
                            {linkedContent?.master_text && <p className="text-ink-500 text-xs mt-1 line-clamp-2">{linkedContent.master_text}</p>}
                            <div className="flex items-center gap-2 mt-2">
                              <Badge color={item.status === 'published' ? 'brand' : item.status === 'failed' ? 'danger' : 'neutral'}>
                                {item.status}
                              </Badge>
                              <span className="text-ink-500 text-xs">{new Date(item.scheduled_for).toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}</span>
                            </div>
                            {!isLocked && (
                              <input
                                type="datetime-local"
                                defaultValue={toLocalDateTimeInput(item.scheduled_for)}
                                onChange={(event) => onReschedule(item, event.target.value)}
                                disabled={reschedulingId === item.id}
                                aria-label="تعديل موعد النشر"
                                className="mt-3 w-full rounded-lg border border-ink-700 bg-ink-900 px-2 py-1.5 text-xs text-ink-200 focus:border-brand-500/50 focus:outline-none"
                              />
                            )}
                          </div>
                        </div>
                      </Card>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
