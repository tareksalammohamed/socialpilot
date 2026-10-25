import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from './supabase';
import type { Workspace } from './types';

type AuthState = {
  session: Session | null;
  user: User | null;
  workspace: Workspace | null;
  isSuperAdmin: boolean;
  loading: boolean;
  signUp: (email: string, password: string) => Promise<{ error: string | null }>;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  refreshWorkspace: () => Promise<void>;
};

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [contextLoading, setContextLoading] = useState(true);
  const currentUserId = useRef<string | null>(null);
  currentUserId.current = user?.id ?? null;

  async function loadWorkspace(userId: string): Promise<Workspace | null> {
    const { data: memberRow, error: memberError } = await supabase
      .from('workspace_members')
      .select('workspace_id')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (memberError) throw memberError;
    if (memberRow?.workspace_id) {
      const { data: ws, error: wsError } = await supabase
        .from('workspaces')
        .select('*')
        .eq('id', memberRow.workspace_id)
        .maybeSingle();
      if (wsError) throw wsError;
      return (ws as Workspace | null) ?? null;
    }

    const { data, error } = await supabase
      .from('workspaces')
      .select('*')
      .eq('owner_id', userId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return (data as Workspace | null) ?? null;
  }

  async function ensureWorkspace(userId: string): Promise<Workspace | null> {
    const existing = await loadWorkspace(userId);
    if (existing) return existing;

    const { error } = await supabase.rpc('create_workspace_with_owner', {
      ws_name: 'مساحتي',
    });
    if (error) return null;

    return loadWorkspace(userId);
  }

  const userId = user?.id;

  const refreshWorkspace = useCallback(async () => {
    if (!userId || isSuperAdmin) return;
    try {
      const { data, error } = await supabase.rpc('is_super_admin', { check_uid: userId });
      if (error) throw error;
      const admin = Boolean(data);
      const ws = admin ? null : await ensureWorkspace(userId);
      if (currentUserId.current === userId) { setIsSuperAdmin(admin); setWorkspace(ws); }
    } catch {
      // Retain the current workspace on transient refresh errors.
    }
    // Helpers use only the singleton client, never component state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, isSuperAdmin]);

  useEffect(() => {
    let mounted = true;
    let receivedEvent = false;
    // This callback only updates local state. Database work happens in the
    // user-id effect, outside the auth lock, and is not repeated on token refresh.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (!mounted) return;
      receivedEvent = true;
      currentUserId.current = nextSession?.user.id ?? null;
      setSession(nextSession);
      setUser(nextSession?.user ?? null);
      setSessionLoading(false);
    });
    void supabase.auth.getSession().then(({ data }) => {
      if (!mounted || receivedEvent) return;
      currentUserId.current = data.session?.user.id ?? null;
      setSession(data.session);
      setUser(data.session?.user ?? null);
      setSessionLoading(false);
    }).catch(() => { if (mounted && !receivedEvent) setSessionLoading(false); });
    return () => { mounted = false; sub.subscription.unsubscribe(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setWorkspace(null);
    setIsSuperAdmin(false);
    if (!userId) { setContextLoading(false); return; }
    setContextLoading(true);
    void (async () => {
      try {
        const { data, error } = await supabase.rpc('is_super_admin', { check_uid: userId });
        if (error) throw error;
        const admin = Boolean(data);
        const ws = admin ? null : await ensureWorkspace(userId);
        if (!cancelled && currentUserId.current === userId) {
          setIsSuperAdmin(admin);
          setWorkspace(ws);
        }
      } catch {
        // AppContent supplies the workspace retry UI; a failed read must never
        // be interpreted as permission to provision another workspace.
      } finally { if (!cancelled) setContextLoading(false); }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  async function signUp(email: string, password: string) {
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) return { error: error.message };
    // Workspace creation is handled atomically by the database trigger. This
    // avoids duplicate Workspaces when Supabase returns an active session.
    return { error: null };
  }

  async function signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) return { error: error.message };
    return { error: null };
  }

  async function signOut() {
    await supabase.auth.signOut();
    setWorkspace(null);
    setIsSuperAdmin(false);
  }

  return (
    <AuthContext.Provider
      value={{ session, user, workspace, isSuperAdmin, loading: sessionLoading || contextLoading, signUp, signIn, signOut, refreshWorkspace }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
