import { useEffect, useState, type ReactNode } from 'react';
import { Home, Plus, FileText, MessageSquare, MoreHorizontal, BarChart3, Loader2, CheckCircle2 } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
import { HomeScreen } from '@/screens/HomeScreen';
import { CreateScreen } from '@/screens/CreateScreen';
import { ContentScreen } from '@/screens/ContentScreen';
import { InboxScreen } from '@/screens/InboxScreen';
import { MoreScreen } from '@/screens/MoreScreen';
import { TaskMonitor } from './TaskMonitor';
import { AnalyticsScreen } from '@/screens/AnalyticsScreen';

type Tab = 'home' | 'create' | 'content' | 'analytics' | 'inbox' | 'more';

const TABS: { id: Tab; label: string; icon: typeof Home }[] = [
  { id: 'home', label: 'الرئيسية', icon: Home },
  { id: 'create', label: 'إنشاء', icon: Plus },
  { id: 'content', label: 'المحتوى', icon: FileText },
  { id: 'analytics', label: 'التحليلات', icon: BarChart3 },
  { id: 'inbox', label: 'الرسائل', icon: MessageSquare },
  { id: 'more', label: 'المزيد', icon: MoreHorizontal },
];

const TAB_PATHS: Record<Tab, string> = {
  home: '/app/dashboard',
  create: '/app/create',
  content: '/app/content',
  analytics: '/app/analytics',
  inbox: '/app/inbox',
  more: '/app/accounts',
};

function tabFromPath(pathname: string): Tab {
  // Legacy Customer Center / Lead Hunter routes are retired.
  // Never render the retired screen even if an old bookmark/deep link exists.
  if (pathname === '/app/customer-center' || pathname === '/app/leads' || pathname === '/app/lead-hunter') {
    window.history.replaceState({}, '', '/app/dashboard');
    return 'home';
  }
  if (pathname === '/app/create') return 'create';
  if (pathname === '/app/content') return 'content';
  if (pathname === '/app/analytics') return 'analytics';
  if (pathname === '/app/inbox' || pathname === '/app/messages') return 'inbox';
  if (pathname === '/app/accounts' || pathname === '/app/more') return 'more';
  return 'home';
}

export type AppShellProps = {
  navigate?: (tab: Tab) => void;
};

export function AppShell() {
  const { workspace, user } = useAuth();
  const [tab, setTab] = useState<Tab>(() => tabFromPath(window.location.pathname));
  const [assistantTaskStatus, setAssistantTaskStatus] = useState<'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | null>(null);
  const [unreadInboxCount, setUnreadInboxCount] = useState(0);

  useEffect(() => {
    if (!workspace?.id || !user?.id) {
      setAssistantTaskStatus(null);
      return;
    }

    let cancelled = false;
    void supabase
      .from('assistant_tasks')
      .select('status')
      .eq('workspace_id', workspace.id)
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (!cancelled) setAssistantTaskStatus((data?.status as 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | undefined) ?? null);
      });

    const channel = supabase
      .channel(`app-assistant-status:${workspace.id}:${user.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'assistant_tasks', filter: `user_id=eq.${user.id}` },
        (payload) => {
          const row = payload.new as { workspace_id?: string; status?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' };
          if (row.workspace_id === workspace.id && row.status) setAssistantTaskStatus(row.status);
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [workspace?.id, user?.id]);

  useEffect(() => {
    if (!workspace?.id) {
      setUnreadInboxCount(0);
      return;
    }
    let cancelled = false;

    const refreshUnread = async () => {
      const { count } = await supabase
        .from('inbox_conversations')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspace.id)
        .eq('unread', true);
      if (!cancelled) setUnreadInboxCount(count ?? 0);
    };

    void refreshUnread();
    const channel = supabase
      .channel(`app-inbox-count:${workspace.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'inbox_conversations', filter: `workspace_id=eq.${workspace.id}` },
        () => void refreshUnread(),
      )
      .subscribe();

    return () => {
      cancelled = true;
      void supabase.removeChannel(channel);
    };
  }, [workspace?.id]);

  useEffect(() => {
    const handlePopState = () => {
      setTab(tabFromPath(window.location.pathname));
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const openPath = (nextPath: string) => {
    setTab(tabFromPath(nextPath));
    if (window.location.pathname !== nextPath) window.history.pushState({}, '', nextPath);
  };

  const navigate = (nextTab: Tab) => openPath(TAB_PATHS[nextTab]);

  const screens: Record<Tab, ReactNode> = {
    home: <HomeScreen onNavigate={navigate} />,
    create: <CreateScreen />,
    content: <ContentScreen />,
    analytics: <AnalyticsScreen />,
    inbox: <InboxScreen />,
    more: <MoreScreen />,
  };

  return (
    <div className="min-h-screen flex flex-col">
      <TaskMonitor />
      <div className="flex-1 overflow-y-auto no-scrollbar pb-28">
        <div key={`${tab}-${workspace?.id ?? 'no-ws'}`} className="animate-fade-in">
          {screens[tab]}
        </div>
      </div>

      <nav className="fixed bottom-0 inset-x-0 z-50 p-3 safe-bottom pointer-events-none">
        <div className="pointer-events-auto flex items-center justify-around max-w-2xl mx-auto px-2 h-16 glass rounded-2xl border border-ink-800/90 shadow-2xl shadow-black/30">
          {TABS.map(({ id, label, icon: Icon }) => {
            const active = tab === id;
            const isCreate = id === 'create';
            const isInbox = id === 'inbox';
            return (
              <button
                key={id}
                onClick={() => navigate(id)}
                aria-current={active ? 'page' : undefined}
                className={`relative flex flex-col items-center justify-center gap-1 flex-1 h-full transition-all rounded-xl ${
                  active && !isCreate ? 'bg-ink-800/60' : ''
                }`}
              >
                {isCreate ? (
                  <div
                    className={`w-11 h-11 rounded-2xl flex items-center justify-center transition-all border ${
                      active
                        ? 'bg-brand-500 text-ink-950 border-brand-400 scale-105 shadow-lg shadow-brand-500/15'
                        : 'bg-ink-800 text-ink-200 border-ink-700'
                    }`}
                  >
                    {(assistantTaskStatus === 'running' || assistantTaskStatus === 'queued') ? (
                      <Loader2 size={22} className="animate-spin" />
                    ) : assistantTaskStatus === 'completed' && !active ? (
                      <CheckCircle2 size={22} />
                    ) : (
                      <Icon size={22} />
                    )}
                  </div>
                ) : (
                  <div className="relative">
                    <Icon size={21} className={active ? 'text-brand-300' : 'text-ink-500'} />
                    {isInbox && unreadInboxCount > 0 && (
                      <span className="absolute -top-2 -left-2 min-w-4 h-4 px-1 rounded-full bg-accent-500 text-ink-950 text-[9px] font-bold flex items-center justify-center">
                        {unreadInboxCount > 99 ? '99+' : unreadInboxCount}
                      </span>
                    )}
                  </div>
                )}
                <span className={`text-[10px] ${active ? 'text-brand-300 font-semibold' : 'text-ink-500'}`}>
                  {label}
                </span>
              </button>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

export type { Tab };
