import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Inbox as InboxIcon,
  Loader2,
  MessageSquare,
  RefreshCw,
  Send,
  Sparkles,
  UserRound,
  Settings2,
  Save,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import {
  listInboxConversations,
  listInboxMessages,
  markInboxConversationRead,
  analyzeInboxConversation,
  setInboxReplyApproval,
  sendInboxReply,
} from '@/lib/api';
import type { InboxAiAnalysis, InboxConversation, InboxMessage } from '@/lib/types';
import { Badge, Button, Card, EmptyState, ErrorBanner, Input, Spinner } from '@/components/ui';

const PLATFORM_LABELS: Record<string, string> = {
  facebook: 'فيسبوك',
  instagram: 'إنستغرام',
  linkedin: 'لينكدإن',
  whatsapp: 'واتساب',
  telegram: 'تيليجرام',
  x: 'X',
  threads: 'ثريدز',
  tiktok: 'تيك توك',
};

type InboxAiSettings = {
  enabled: boolean;
  autoAnalyze: boolean;
  tone: 'professional' | 'friendly' | 'sales';
  language: 'ar' | 'auto';
  responseGoal: string;
  businessContext: string;
  forbiddenTopics: string;
  maxReplyLength: number;
};

const DEFAULT_AI_SETTINGS: InboxAiSettings = {
  enabled: true,
  autoAnalyze: false,
  tone: 'professional',
  language: 'ar',
  responseGoal: 'حل استفسار العميل بوضوح ثم توجيهه للخطوة التالية المناسبة بدون ضغط أو وعود غير مؤكدة.',
  businessContext: '',
  forbiddenTopics: '',
  maxReplyLength: 320,
};

function readInboxAiSettings(settings: Record<string, unknown> | null | undefined): InboxAiSettings {
  const raw = (settings?.inbox_ai ?? {}) as Partial<InboxAiSettings>;
  return {
    enabled: raw.enabled !== false,
    autoAnalyze: raw.autoAnalyze === true,
    tone: raw.tone === 'friendly' || raw.tone === 'sales' ? raw.tone : 'professional',
    language: raw.language === 'auto' ? 'auto' : 'ar',
    responseGoal: typeof raw.responseGoal === 'string' ? raw.responseGoal : DEFAULT_AI_SETTINGS.responseGoal,
    businessContext: typeof raw.businessContext === 'string' ? raw.businessContext : '',
    forbiddenTopics: typeof raw.forbiddenTopics === 'string' ? raw.forbiddenTopics : '',
    maxReplyLength: typeof raw.maxReplyLength === 'number'
      ? Math.max(80, Math.min(1000, Math.round(raw.maxReplyLength)))
      : DEFAULT_AI_SETTINGS.maxReplyLength,
  };
}

function canReplyToConversation(conversation: InboxConversation): boolean {
  if (conversation.platform === 'facebook' || conversation.platform === 'instagram') return true;
  if (conversation.platform === 'whatsapp' || conversation.platform === 'telegram') return conversation.type === 'dm';
  if (conversation.platform === 'linkedin') return conversation.type === 'comment';
  return false;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ar', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }).format(date);
}

function messageLabel(message: InboxMessage): string {
  if (message.direction === 'outbound') return 'أنت';
  return message.sender_name || 'الزائر';
}

export function InboxScreen() {
  const { workspace, user, refreshWorkspace } = useAuth();
  const [conversations, setConversations] = useState<InboxConversation[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<InboxMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [messagesError, setMessagesError] = useState<string | null>(null);
  const [aiAnalysis, setAiAnalysis] = useState<InboxAiAnalysis | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [approvalLoading, setApprovalLoading] = useState(false);
  const [analysisLoaded, setAnalysisLoaded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsNotice, setSettingsNotice] = useState<string | null>(null);
  const [aiSettings, setAiSettings] = useState<InboxAiSettings>(() => readInboxAiSettings(workspace?.settings));
  const autoAnalyzeKeyRef = useRef<string | null>(null);

  const canManageAiSettings = !!workspace && !!user && workspace.owner_id === user.id;

  useEffect(() => {
    setAiSettings(readInboxAiSettings(workspace?.settings));
  }, [workspace?.id, workspace?.settings]);

  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedId) ?? null,
    [conversations, selectedId],
  );

  const loadConversations = useCallback(async (silent = false) => {
    if (!workspace?.id) return;
    if (!silent) setLoading(true);
    setError(null);
    try {
      const data = await listInboxConversations(workspace.id);
      setConversations(data);
      setSelectedId((current) => (current && data.some((item) => item.id === current) ? current : data[0]?.id ?? null));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'تعذّر تحميل المحادثات');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [workspace?.id]);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    if (!workspace?.id || !selectedId) {
      setMessages([]);
      setAiAnalysis(null);
      setAnalysisLoaded(false);
      return;
    }
    let cancelled = false;
    setMessagesLoading(true);
    setMessagesError(null);
    setAnalysisLoaded(false);
    setAiAnalysis(null);
    void listInboxMessages(workspace.id, selectedId)
      .then((data) => {
        if (!cancelled) setMessages(data);
      })
      .catch((cause) => {
        if (!cancelled) setMessagesError(cause instanceof Error ? cause.message : 'تعذّر تحميل الرسائل');
      })
      .finally(() => {
        if (!cancelled) setMessagesLoading(false);
    });
    void markInboxConversationRead(selectedId).catch(() => undefined);
    void supabase
      .from('inbox_ai_analyses')
      .select('*')
      .eq('workspace_id', workspace.id)
      .eq('conversation_id', selectedId)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) {
          setAiAnalysis((data as InboxAiAnalysis | null) ?? null);
          setAnalysisLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setAnalysisLoaded(true);
      });
    setConversations((current) => current.map((item) => (item.id === selectedId ? { ...item, unread: false } : item)));
    return () => {
      cancelled = true;
    };
  }, [workspace?.id, selectedId]);

  useEffect(() => {
    if (!workspace?.id) return;
    const channel = supabase
      .channel(`inbox:${workspace.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'inbox_conversations', filter: `workspace_id=eq.${workspace.id}` },
        () => { void loadConversations(true); },
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'inbox_messages', filter: `workspace_id=eq.${workspace.id}` },
        (payload) => {
          const row = payload.new as InboxMessage;
          if (row.conversation_id === selectedId) {
            setMessages((current) => current.some((item) => item.id === row.id) ? current : [...current, row]);
          }
          void loadConversations(true);
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [workspace?.id, selectedId, loadConversations]);

  useEffect(() => {
    if (!selectedConversation || !analysisLoaded || aiAnalysis || aiLoading || !aiSettings.enabled || !aiSettings.autoAnalyze) return;
    if (autoAnalyzeKeyRef.current === selectedConversation.id) return;
    autoAnalyzeKeyRef.current = selectedConversation.id;
    void handleAnalyzeConversation();
  }, [selectedConversation, analysisLoaded, aiAnalysis, aiLoading, aiSettings.enabled, aiSettings.autoAnalyze]);

  async function handleSaveAiSettings() {
    if (!workspace || !user || !canManageAiSettings || settingsSaving) return;
    setSettingsSaving(true);
    setSettingsNotice(null);
    setAiError(null);
    try {
      const nextSettings = { ...(workspace.settings ?? {}), inbox_ai: aiSettings };
      const { error: updateError } = await supabase
        .from('workspaces')
        .update({ settings: nextSettings, updated_at: new Date().toISOString() })
        .eq('id', workspace.id)
        .eq('owner_id', user.id);
      if (updateError) throw updateError;
      await refreshWorkspace();
      setSettingsNotice('تم حفظ إعدادات مساعد الوارد.');
    } catch (cause) {
      setAiError(cause instanceof Error ? cause.message : 'تعذّر حفظ إعدادات مساعد الوارد');
    } finally {
      setSettingsSaving(false);
    }
  }

  async function handleAnalyzeConversation() {
    if (!selectedConversation || aiLoading) return;
    if (!aiSettings.enabled) {
      setAiError('مساعد الذكاء الاصطناعي معطّل من إعدادات صندوق الوارد.');
      return;
    }
    setAiLoading(true);
    setAiError(null);
    try {
      setAiAnalysis(await analyzeInboxConversation(selectedConversation.id));
    } catch (cause) {
      setAiError(cause instanceof Error ? cause.message : 'تعذّر تحليل المحادثة');
    } finally {
      setAiLoading(false);
    }
  }

  async function handleApproveReply() {
    if (!selectedConversation || !aiAnalysis?.suggested_reply || approvalLoading) return;
    setApprovalLoading(true);
    setAiError(null);
    try {
      const approved = await setInboxReplyApproval({ conversationId: selectedConversation.id, action: 'approve_reply', reply: aiAnalysis.suggested_reply });
      setAiAnalysis(approved);
      setDraft(approved.approved_reply ?? approved.suggested_reply ?? '');
    } catch (cause) {
      setAiError(cause instanceof Error ? cause.message : 'تعذّر اعتماد الرد المقترح');
    } finally {
      setApprovalLoading(false);
    }
  }

  async function handleRejectReply() {
    if (!selectedConversation || !aiAnalysis || approvalLoading) return;
    setApprovalLoading(true);
    setAiError(null);
    try {
      setAiAnalysis(await setInboxReplyApproval({ conversationId: selectedConversation.id, action: 'reject_reply' }));
    } catch (cause) {
      setAiError(cause instanceof Error ? cause.message : 'تعذّر رفض الرد المقترح');
    } finally {
      setApprovalLoading(false);
    }
  }

  async function handleSend() {
    if (!selectedConversation || !draft.trim() || sending) return;
    setSending(true);
    setMessagesError(null);
    try {
      const message = await sendInboxReply(selectedConversation.id, draft);
      setMessages((current) => current.some((item) => item.id === message.id) ? current : [...current, message]);
      setDraft('');
      setConversations((current) => current.map((item) => (
        item.id === selectedConversation.id
          ? { ...item, snippet: message.content, unread: false, updated_at: message.created_at }
          : item
      )));
    } catch (cause) {
      setMessagesError(cause instanceof Error ? cause.message : 'تعذّر إرسال الرد');
    } finally {
      setSending(false);
    }
  }

  if (!workspace) return null;

  return (
    <div className="px-5 py-6 safe-top max-w-5xl mx-auto w-full">
      <div className="flex items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-2">
          <InboxIcon size={22} className="text-brand-400" />
          <div>
            <h1 className="text-lg font-bold text-ink-50">صندوق الرسائل الموحد</h1>
            <p className="text-xs text-ink-500 mt-0.5">التعليقات والمحادثات من الحسابات المتصلة</p>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void loadConversations()} disabled={loading}>
          {loading ? <Spinner size={16} /> : <RefreshCw size={16} />}
          <span className="sr-only">تحديث</span>
        </Button>
      </div>

      {error && <div className="mb-4"><ErrorBanner message={error} /></div>}

      <Card className="mb-4 !p-0 overflow-hidden">
        <button
          type="button"
          onClick={() => setSettingsOpen((value) => !value)}
          className="w-full px-4 py-3 flex items-center justify-between gap-3 text-right hover:bg-ink-900/50 transition-colors"
        >
          <div className="flex items-center gap-2">
            <Settings2 size={17} className="text-brand-400" />
            <div>
              <p className="text-sm font-semibold text-ink-100">إعدادات مساعد الوارد AI</p>
              <p className="text-[11px] text-ink-500 mt-0.5">
                {aiSettings.enabled ? 'مفعّل' : 'متوقف'} · {aiSettings.autoAnalyze ? 'تحليل تلقائي عند فتح المحادثة' : 'تحليل عند الطلب'} · الإرسال بمراجعة بشرية
              </p>
            </div>
          </div>
          <Badge color={aiSettings.enabled ? 'accent' : 'neutral'}>{aiSettings.enabled ? 'جاهز' : 'متوقف'}</Badge>
        </button>

        {settingsOpen && (
          <div className="border-t border-ink-800 p-4 space-y-4">
            {!canManageAiSettings && (
              <p className="text-xs text-warning-400">تعديل هذه الإعدادات متاح لمالك مساحة العمل فقط.</p>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="flex items-center justify-between gap-3 rounded-xl bg-ink-900 px-3 py-2.5">
                <span className="text-xs text-ink-300">تشغيل مساعد الذكاء الاصطناعي</span>
                <input
                  type="checkbox"
                  checked={aiSettings.enabled}
                  disabled={!canManageAiSettings}
                  onChange={(event) => setAiSettings((current) => ({ ...current, enabled: event.target.checked }))}
                />
              </label>
              <label className="flex items-center justify-between gap-3 rounded-xl bg-ink-900 px-3 py-2.5">
                <span className="text-xs text-ink-300">تحليل تلقائي عند فتح المحادثة</span>
                <input
                  type="checkbox"
                  checked={aiSettings.autoAnalyze}
                  disabled={!canManageAiSettings || !aiSettings.enabled}
                  onChange={(event) => setAiSettings((current) => ({ ...current, autoAnalyze: event.target.checked }))}
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-ink-500">أسلوب الرد</span>
                <select
                  value={aiSettings.tone}
                  disabled={!canManageAiSettings}
                  onChange={(event) => setAiSettings((current) => ({ ...current, tone: event.target.value as InboxAiSettings['tone'] }))}
                  className="w-full rounded-xl border border-ink-800 bg-ink-900 px-3 py-2.5 text-sm text-ink-100"
                >
                  <option value="professional">احترافي</option>
                  <option value="friendly">ودود</option>
                  <option value="sales">بيعي هادئ</option>
                </select>
              </label>
              <label className="space-y-1">
                <span className="text-xs text-ink-500">لغة الرد</span>
                <select
                  value={aiSettings.language}
                  disabled={!canManageAiSettings}
                  onChange={(event) => setAiSettings((current) => ({ ...current, language: event.target.value as InboxAiSettings['language'] }))}
                  className="w-full rounded-xl border border-ink-800 bg-ink-900 px-3 py-2.5 text-sm text-ink-100"
                >
                  <option value="ar">العربية</option>
                  <option value="auto">نفس لغة العميل</option>
                </select>
              </label>
            </div>

            <label className="block space-y-1">
              <span className="text-xs text-ink-500">هدف الرد</span>
              <textarea
                value={aiSettings.responseGoal}
                disabled={!canManageAiSettings}
                onChange={(event) => setAiSettings((current) => ({ ...current, responseGoal: event.target.value }))}
                rows={2}
                className="w-full rounded-xl border border-ink-800 bg-ink-900 px-3 py-2.5 text-sm text-ink-100 resize-y"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-ink-500">معلومات النشاط التي يُسمح للـAI باستخدامها</span>
              <textarea
                value={aiSettings.businessContext}
                disabled={!canManageAiSettings}
                onChange={(event) => setAiSettings((current) => ({ ...current, businessContext: event.target.value }))}
                rows={3}
                placeholder="الخدمات، مواعيد العمل، سياسة الأسعار، روابط أو معلومات ثابتة..."
                className="w-full rounded-xl border border-ink-800 bg-ink-900 px-3 py-2.5 text-sm text-ink-100 resize-y"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-ink-500">ممنوعات أو معلومات لا يذكرها المساعد</span>
              <textarea
                value={aiSettings.forbiddenTopics}
                disabled={!canManageAiSettings}
                onChange={(event) => setAiSettings((current) => ({ ...current, forbiddenTopics: event.target.value }))}
                rows={2}
                placeholder="مثال: لا تعد بخصومات غير مؤكدة، لا تذكر أسعارًا إلا إذا كانت موجودة بالسياق..."
                className="w-full rounded-xl border border-ink-800 bg-ink-900 px-3 py-2.5 text-sm text-ink-100 resize-y"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs text-ink-500">الحد التقريبي لطول الرد: {aiSettings.maxReplyLength} حرف</span>
              <input
                type="range"
                min={80}
                max={1000}
                step={20}
                value={aiSettings.maxReplyLength}
                disabled={!canManageAiSettings}
                onChange={(event) => setAiSettings((current) => ({ ...current, maxReplyLength: Number(event.target.value) }))}
                className="w-full"
              />
            </label>
            <div className="flex items-center justify-between gap-3">
              <p className="text-[11px] text-ink-500">الـAI يقترح ويحلل، لكن لا يرسل أي رد تلقائيًا بدون ضغط المستخدم على إرسال.</p>
              {canManageAiSettings && (
                <Button size="sm" onClick={() => void handleSaveAiSettings()} disabled={settingsSaving}>
                  {settingsSaving ? <Spinner size={14} /> : <Save size={14} />}
                  حفظ إعدادات AI
                </Button>
              )}
            </div>
            {settingsNotice && <p className="text-xs text-accent-300">{settingsNotice}</p>}
          </div>
        )}
      </Card>

      {loading ? (
        <div className="py-20 flex justify-center"><Spinner className="text-brand-400" size={28} /></div>
      ) : conversations.length === 0 ? (
        <Card>
          <EmptyState
            icon={<MessageSquare size={28} />}
            title="لا توجد محادثات بعد"
            subtitle="ستظهر هنا رسائل وتعليقات الحسابات المتصلة بعد وصول أول Webhook."
          />
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-[minmax(220px,0.8fr)_minmax(0,1.4fr)] gap-4">
          <Card className="p-0 overflow-hidden">
            <div className="px-4 py-3 border-b border-ink-800 flex items-center justify-between">
              <span className="text-sm font-semibold text-ink-100">المحادثات</span>
              <Badge color="brand">{conversations.filter((item) => item.unread).length} جديدة</Badge>
            </div>
            <div className="max-h-[560px] overflow-y-auto">
              {conversations.map((conversation) => {
                const active = conversation.id === selectedId;
                return (
                  <button
                    key={conversation.id}
                    type="button"
                    onClick={() => setSelectedId(conversation.id)}
                    className={`w-full text-right px-4 py-3 border-b border-ink-900 transition-colors ${active ? 'bg-brand-500/10' : 'hover:bg-ink-900/70'}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm text-ink-100 font-medium truncate">{conversation.sender_name || 'محادثة بدون اسم'}</p>
                        <p className="text-xs text-ink-500 mt-1 truncate">{conversation.snippet || 'لا يوجد نص'}</p>
                      </div>
                      {conversation.unread && <span className="w-2 h-2 rounded-full bg-brand-400 shrink-0 mt-1.5" />}
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-2 text-[11px] text-ink-600">
                      <span>{PLATFORM_LABELS[conversation.platform] || conversation.platform}</span>
                      <span>{formatDate(conversation.updated_at)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </Card>

          <Card className="p-0 overflow-hidden min-h-[560px] flex flex-col">
            {selectedConversation ? (
              <>
                <div className="px-4 py-3 border-b border-ink-800 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-9 h-9 rounded-xl bg-ink-800 flex items-center justify-center text-ink-400 shrink-0">
                      <UserRound size={18} />
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-ink-100 truncate">{selectedConversation.sender_name || 'محادثة'}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <Badge color="neutral">{PLATFORM_LABELS[selectedConversation.platform] || selectedConversation.platform}</Badge>
                        <span className="text-[11px] text-ink-500">{selectedConversation.type === 'comment' ? 'تعليق' : 'رسالة مباشرة'}</span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="secondary" size="sm" onClick={() => void handleAnalyzeConversation()} disabled={aiLoading || !aiSettings.enabled}>
                      {aiLoading ? <Spinner size={14} /> : <Sparkles size={14} />}
                      <span className="hidden sm:inline">تحليل AI</span>
                    </Button>
                    <button type="button" className="md:hidden text-ink-500" onClick={() => setSelectedId(null)} aria-label="رجوع">
                      <ArrowRight size={18} />
                    </button>
                  </div>
                </div>

                {(aiError || aiAnalysis) && (
                  <div className="px-4 pt-3">
                    {aiError && <ErrorBanner message={aiError} />}
                    {aiAnalysis && (
                      <div className="rounded-xl border border-brand-500/25 bg-brand-500/5 p-3 space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <p className="text-xs font-semibold text-brand-200">مساعد المبيعات AI</p>
                          <Badge color={aiAnalysis.priority === 'urgent' || aiAnalysis.priority === 'high' ? 'warning' : 'neutral'}>
                            أولوية {aiAnalysis.priority === 'urgent' ? 'عاجلة' : aiAnalysis.priority === 'high' ? 'عالية' : aiAnalysis.priority === 'low' ? 'منخفضة' : 'عادية'}
                          </Badge>
                        </div>
                        <div className="grid grid-cols-2 gap-2 text-xs text-ink-300">
                          <span>النية: <strong className="text-ink-100">{aiAnalysis.intent}</strong></span>
                          <span>احتمال Lead: <strong className="text-ink-100">{aiAnalysis.lead_score}%</strong></span>
                        </div>
                        <p className="text-xs text-ink-300">{aiAnalysis.summary}</p>
                        <p className="text-xs text-ink-400">الخطوة التالية: {aiAnalysis.next_best_action}</p>
                        {aiAnalysis.suggested_reply && (
                          <div className="rounded-lg bg-ink-900/80 p-2.5 text-xs text-ink-200">
                            <span className="text-ink-500 block mb-1">رد مقترح — لا يتم إرساله تلقائيًا</span>
                            <p className="whitespace-pre-wrap">{aiAnalysis.approved_reply ?? aiAnalysis.suggested_reply}</p>
                            <div className="flex items-center gap-2 mt-2">
                              {aiAnalysis.reply_status === 'approved' ? (
                                <Badge color="accent">تم الاعتماد — راجع المسودة ثم أرسل يدويًا</Badge>
                              ) : (
                                <>
                                  <Button size="sm" variant="secondary" onClick={() => void handleApproveReply()} disabled={approvalLoading || aiAnalysis.quality_verdict === 'fail'}>
                                    {approvalLoading ? <Spinner size={14} /> : <Sparkles size={14} />}
                                    اعتماد ووضعه في المسودة
                                  </Button>
                                  <Button size="sm" variant="ghost" onClick={() => void handleRejectReply()} disabled={approvalLoading}>
                                    رفض
                                  </Button>
                                </>
                              )}
                            </div>
                          </div>
                        )}
                        <p className={`text-[11px] ${aiAnalysis.quality_verdict === 'pass' ? 'text-accent-300' : 'text-warning-300'}`}>
                          مراجعة الجودة: {aiAnalysis.quality_verdict === 'pass' ? 'مقبول مبدئيًا' : aiAnalysis.quality_verdict === 'fail' ? 'مرفوض' : 'يحتاج مراجعة بشرية'}
                        </p>
                      </div>
                    )}
                  </div>
                )}

                <div className="flex-1 p-4 space-y-3 overflow-y-auto min-h-[360px]">
                  {messagesError && <ErrorBanner message={messagesError} />}
                  {messagesLoading ? (
                    <div className="h-full flex items-center justify-center"><Loader2 className="animate-spin text-brand-400" size={24} /></div>
                  ) : messages.length === 0 ? (
                    <EmptyState icon={<MessageSquare size={24} />} title="لا توجد رسائل محفوظة" subtitle="ستتم مزامنة الرسائل الجديدة من Webhook." />
                  ) : (
                    messages.map((message) => (
                      <div key={message.id} className={`flex ${message.direction === 'outbound' ? 'justify-start' : 'justify-end'}`}>
                        <div className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 ${message.direction === 'outbound' ? 'bg-brand-500/15 text-brand-100' : 'bg-ink-800 text-ink-100'}`}>
                          <div className="flex items-center justify-between gap-3 mb-1 text-[10px] text-ink-500">
                            <span>{messageLabel(message)}</span>
                            <span>{formatDate(message.created_at)}</span>
                          </div>
                          <p className="text-sm whitespace-pre-wrap break-words">{message.content}</p>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                <div className="p-3 border-t border-ink-800">
                  {!canReplyToConversation(selectedConversation) && (
                    <p className="text-xs text-warning-400 mb-2">
                      {selectedConversation.platform === 'linkedin' && selectedConversation.type === 'dm'
                        ? 'LinkedIn لا يتيح إرسال الرسائل الخاصة من خلال الـAPI القياسي؛ يمكنك استخدام AI لصياغة الرد ثم إرساله يدويًا من LinkedIn.'
                        : 'الرد المباشر لهذه المحادثة غير مدعوم من خلال API الحالي.'}
                    </p>
                  )}
                  <div className="flex items-end gap-2">
                    <Input
                      value={draft}
                      onChange={setDraft}
                      placeholder="اكتب ردًا..."
                      className="flex-1"
                    />
                    <Button
                      size="sm"
                      onClick={() => void handleSend()}
                      disabled={sending || !draft.trim() || !canReplyToConversation(selectedConversation)}
                      className="shrink-0"
                    >
                      {sending ? <Spinner size={16} /> : <Send size={16} />}
                      <span className="sr-only">إرسال</span>
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <EmptyState icon={<MessageSquare size={28} />} title="اختر محادثة" subtitle="اختر محادثة من القائمة لعرض الرسائل." />
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
