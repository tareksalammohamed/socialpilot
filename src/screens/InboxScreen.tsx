import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  Inbox as InboxIcon,
  Loader2,
  MessageSquare,
  RefreshCw,
  Send,
  Sparkles,
  UserRound,
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

const REPLY_SUPPORTED = new Set(['facebook', 'instagram', 'linkedin', 'whatsapp', 'telegram']);

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
  const { workspace } = useAuth();
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

  const selectedConversation = useMemo(
    () => conversations.find((conversation) => conversation.id === selectedId) ?? null,
    [conversations, selectedId],
  );

  const loadConversations = useCallback(async () => {
    if (!workspace?.id) return;
    setLoading(true);
    setError(null);
    try {
      const data = await listInboxConversations(workspace.id);
      setConversations(data);
      setSelectedId((current) => (current && data.some((item) => item.id === current) ? current : data[0]?.id ?? null));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'تعذّر تحميل المحادثات');
    } finally {
      setLoading(false);
    }
  }, [workspace?.id]);

  useEffect(() => {
    void loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    if (!workspace?.id || !selectedId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    setMessagesLoading(true);
    setMessagesError(null);
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
      .then(({ data }) => setAiAnalysis((data as InboxAiAnalysis | null) ?? null));
    setConversations((current) => current.map((item) => (item.id === selectedId ? { ...item, unread: false } : item)));
    return () => {
      cancelled = true;
    };
  }, [workspace?.id, selectedId]);

  async function handleAnalyzeConversation() {
    if (!selectedConversation || aiLoading) return;
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
      setMessages((current) => [...current, message]);
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
                    <Button variant="secondary" size="sm" onClick={() => void handleAnalyzeConversation()} disabled={aiLoading}>
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
                  {!REPLY_SUPPORTED.has(selectedConversation.platform) && (
                    <p className="text-xs text-warning-400 mb-2">الرد المباشر لهذه المنصة غير مدعوم من خلال API الحالي.</p>
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
                      disabled={sending || !draft.trim() || !REPLY_SUPPORTED.has(selectedConversation.platform)}
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
