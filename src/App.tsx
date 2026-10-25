import { lazy, Suspense, useEffect, useState } from 'react';
import { AuthProvider, useAuth } from '@/lib/auth';
import { supabase } from '@/lib/supabase';
const AuthScreen = lazy(() => import('@/screens/AuthScreen').then(module => ({ default: module.AuthScreen })));
const BrandBrainOnboarding = lazy(() => import('@/screens/BrandBrainOnboarding').then(module => ({ default: module.BrandBrainOnboarding })));
const AppShell = lazy(() => import('@/components/AppShell').then(module => ({ default: module.AppShell })));
const SuperAdminScreen = lazy(() => import('@/screens/SuperAdminScreen').then(module => ({ default: module.SuperAdminScreen })));
import { ScreenLoader, Button } from '@/components/ui';
import { AlertCircle } from 'lucide-react';
import { ScreenErrorBoundary } from '@/components/ScreenErrorBoundary';
import type { BrandDna } from '@/lib/types';

function AppContent() {
  const { user, workspace, isSuperAdmin, loading, signOut, refreshWorkspace } = useAuth();
  const [brandDna, setBrandDna] = useState<BrandDna | null>(null);
  const [dnaLoading, setDnaLoading] = useState(true);
  const [dnaError, setDnaError] = useState(false);
  const [dnaRetry, setDnaRetry] = useState(0);
  const [retryCount, setRetryCount] = useState(0);

  const workspaceId = workspace?.id;

  useEffect(() => {
    if (!workspaceId) {
      setBrandDna(null);
      setDnaLoading(false);
      return;
    }
    let cancelled = false;
    setDnaLoading(true);
    setDnaError(false);
    supabase
      .from('brand_dna')
      .select('*')
      .eq('workspace_id', workspaceId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        setDnaError(Boolean(error));
        setBrandDna((data as BrandDna | null) ?? null);
        setDnaLoading(false);
      });
    return () => { cancelled = true; };
  }, [workspaceId, dnaRetry]);

  useEffect(() => {
    if (loading || !user || isSuperAdmin || workspace) return;
    if (retryCount >= 2) return;
    const timer = setTimeout(() => {
      setRetryCount((c) => c + 1);
      refreshWorkspace();
    }, 3000);
    return () => clearTimeout(timer);
  }, [loading, user, isSuperAdmin, workspace, retryCount, refreshWorkspace]);

  if (loading) return <ScreenLoader fullScreen />;

  if (!user) return <AuthScreen />;

  // Super Admin is platform-level and intentionally does not need a Workspace.
  if (isSuperAdmin) return <SuperAdminScreen onBack={signOut} />;

  if (!workspace) {
    if (retryCount >= 2) {
      return (
        <div className="min-h-screen flex flex-col items-center justify-center px-6 gap-4 text-center">
          <div className="w-16 h-16 rounded-2xl bg-danger-500/15 border border-danger-500/30 flex items-center justify-center">
            <AlertCircle className="text-danger-400" size={32} />
          </div>
          <p className="text-ink-100 font-medium">تعذّر إنشاء مساحتك</p>
          <p className="text-ink-400 text-sm max-w-xs">
            حدث خطأ أثناء إعداد المساحة. حاول مرة أخرى أو سجّل خروج وأعد المحاولة.
          </p>
          <div className="flex gap-3 mt-2">
            <Button
              variant="secondary"
              onClick={() => {
                setRetryCount(0);
                refreshWorkspace();
              }}
            >
              إعادة المحاولة
            </Button>
            <Button variant="ghost" onClick={signOut} className="text-danger-400">
              تسجيل خروج
            </Button>
          </div>
        </div>
      );
    }

    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-6 gap-4">
        <ScreenLoader label="جارٍ إعداد مساحتك..." />
        {retryCount > 0 && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setRetryCount(retryCount + 1);
              refreshWorkspace();
            }}
          >
            إعادة المحاولة
          </Button>
        )}
      </div>
    );
  }

  if (dnaLoading) return <ScreenLoader label="جارٍ التحميل..." />;

  if (dnaError) return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-6 text-center" role="alert">
      <p>تعذّر تحميل بيانات علامتك التجارية. أعد المحاولة لاستكمال العمل.</p>
      <Button onClick={() => setDnaRetry(value => value + 1)}>إعادة المحاولة</Button>
    </div>
  );

  if (!brandDna || brandDna.status === 'draft') {
    return <BrandBrainOnboarding />;
  }

  return <AppShell />;
}

export default function App() {
  return (
    <AuthProvider>
      <ScreenErrorBoundary>
        <Suspense fallback={<ScreenLoader fullScreen />}><AppContent /></Suspense>
      </ScreenErrorBoundary>
    </AuthProvider>
  );
}
