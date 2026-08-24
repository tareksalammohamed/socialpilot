import { useEffect, useState, type ReactNode } from 'react';
import { Home, Plus, FileText, MessageSquare, MoreHorizontal, BarChart3 } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { HomeScreen } from '@/screens/HomeScreen';
import { CreateScreen } from '@/screens/CreateScreen';
import { ContentScreen } from '@/screens/ContentScreen';
import { InboxScreen } from '@/screens/InboxScreen';
import { MoreScreen } from '@/screens/MoreScreen';
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
  const { workspace } = useAuth();
  const [tab, setTab] = useState<Tab>(() => tabFromPath(window.location.pathname));

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
    <div className="min-h-screen bg-ink-950 flex flex-col">
      <div className="flex-1 overflow-y-auto no-scrollbar pb-20">
        <div key={`${tab}-${workspace?.id ?? 'no-ws'}`} className="animate-fade-in">
          {screens[tab]}
        </div>
      </div>

      <nav className="fixed bottom-0 inset-x-0 z-50 glass border-t border-ink-800 safe-bottom">
        <div className="flex items-center justify-around max-w-md mx-auto px-2 h-16">
          {TABS.map(({ id, label, icon: Icon }) => {
            const active = tab === id;
            const isCreate = id === 'create';
            return (
              <button
                key={id}
                onClick={() => navigate(id)}
                className="flex flex-col items-center gap-1 flex-1 py-2 transition-all"
              >
                {isCreate ? (
                  <div
                    className={`w-11 h-11 rounded-2xl flex items-center justify-center transition-all ${
                      active
                        ? 'bg-brand-500 text-ink-950 scale-105'
                        : 'bg-ink-800 text-ink-300'
                    }`}
                  >
                    <Icon size={22} />
                  </div>
                ) : (
                  <Icon
                    size={22}
                    className={active ? 'text-brand-400' : 'text-ink-500'}
                  />
                )}
                <span
                  className={`text-[10px] ${active ? 'text-brand-400 font-medium' : 'text-ink-500'}`}
                >
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
