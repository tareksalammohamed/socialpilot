import { supabase } from './supabase';
import type { AiGatewayRequest, AiGatewayResponse, InboxConversation, InboxMessage, AgentContext, AgentTurnResult, AgentToolResult } from './types';

export async function startSocialOAuth(workspaceId: string, platformKey: 'meta' | 'linkedin' | 'x' = 'meta'): Promise<string> {
  const { data: session } = await supabase.auth.getSession();
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/social-oauth-start`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.session?.access_token ?? ''}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
    },
    body: JSON.stringify({ workspaceId, platformKey }),
  });

  let body: Record<string, unknown> = {};
  try {
    body = await res.json();
  } catch {
    // ignore parse errors, handled below
  }

  if (!res.ok || !body.url) {
    throw new Error((body?.error as string) ?? `تعذّر بدء الربط (${res.status})`);
  }
  return body.url as string;
}

async function callTelegramConnect<T>(payload: Record<string, unknown>): Promise<T> {
  const { data: session } = await supabase.auth.getSession();
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/social-telegram-connect`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.session?.access_token ?? ''}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
    },
    body: JSON.stringify(payload),
  });

  let body: Record<string, unknown> = {};
  try {
    body = await res.json();
  } catch {
    // ignore parse errors, handled below
  }

  if (!res.ok) {
    throw new Error((body?.error as string) ?? `فشل الطلب (${res.status})`);
  }
  return body as T;
}

export function getTelegramBotInfo(): Promise<{ configured: boolean; enabled?: boolean; botUsername?: string }> {
  return callTelegramConnect<{ configured: boolean; enabled?: boolean; botUsername?: string }>({ action: 'get_bot_info' });
}

export async function connectTelegramChannel(workspaceId: string, channelUsername: string) {
  return callTelegramConnect<{ ok: true; account: unknown }>({ action: 'connect', workspaceId, channelUsername });
}

export type PublishResult = {
  ok: true;
  postId?: string;
  url?: string | null;
  alreadyPublished?: boolean;
  job?: unknown;
};

export async function publishVariant(params: {
  workspaceId: string;
  variantId: string;
  calendarItemId?: string;
}): Promise<PublishResult> {
  const { data: session } = await supabase.auth.getSession();
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/social-publish`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.session?.access_token ?? ''}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
    },
    body: JSON.stringify(params),
  });

  let resBody: Record<string, unknown> = {};
  try {
    resBody = await res.json();
  } catch {
    // ignore parse errors, handled below
  }

  if (!res.ok) {
    throw new Error((resBody?.error as string) ?? `فشل النشر (${res.status})`);
  }
  return resBody as PublishResult;
}

export async function callAiGateway(req: AiGatewayRequest): Promise<AiGatewayResponse> {
  const { data: session } = await supabase.auth.getSession();
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai-gateway`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.session?.access_token ?? ''}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
    },
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    let detail = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      if (body?.error) detail = body.error;
    } catch {
      // ignore parse errors
    }
    throw new Error(detail);
  }

  const data = (await res.json()) as AiGatewayResponse;
  if (!data || !data.result) {
    throw new Error('Received an unexpected response from the AI service.');
  }
  return data;
}

// Universal AI Agent — free-text request, no fixed intent (section 2/3 of
// the SocialPilot V2 spec). Same edge function, `agentMode: true`.
// Phase 5 — execute tool calls the user has explicitly approved (from a
// prior turn's `pendingApproval.toolCalls`). Sends them back unmodified.
export async function callApprovedTools(params: {
  workspaceId: string;
  toolCalls: { id: string; name: string; input: Record<string, unknown> }[];
  agentContext?: AgentContext;
  legacyContext?: Record<string, unknown>;
}): Promise<{ toolResults: AgentToolResult[] }> {
  const { data: session } = await supabase.auth.getSession();
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai-gateway`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.session?.access_token ?? ''}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
    },
    body: JSON.stringify({
      agentMode: true,
      workspaceId: params.workspaceId,
      approvedToolCalls: params.toolCalls,
      agentContext: params.agentContext,
      legacyContext: params.legacyContext,
    }),
  });

  let body: Record<string, unknown> = {};
  try {
    body = await res.json();
  } catch {
    // ignore parse errors, handled below
  }
  if (!res.ok) {
    throw new Error((body?.error as string) ?? `فشل تنفيذ الإجراء المعتمد (${res.status})`);
  }
  return body as { toolResults: AgentToolResult[] };
}

export async function callAgentTurn(params: {
  workspaceId: string;
  message: string;
  platforms?: string[];
  agentContext?: AgentContext;
  legacyContext?: Record<string, unknown>;
}): Promise<AgentTurnResult> {
  const { data: session } = await supabase.auth.getSession();
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai-gateway`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.session?.access_token ?? ''}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
    },
    body: JSON.stringify({
      agentMode: true,
      workspaceId: params.workspaceId,
      message: params.message,
      platforms: params.platforms,
      agentContext: params.agentContext,
      legacyContext: params.legacyContext,
    }),
  });

  let body: Record<string, unknown> = {};
  try {
    body = await res.json();
  } catch {
    // ignore parse errors, handled below
  }

  if (!res.ok) {
    throw new Error((body?.error as string) ?? `فشل طلب الـAgent (${res.status})`);
  }
  return body as AgentTurnResult;
}


export async function listInboxConversations(workspaceId: string): Promise<InboxConversation[]> {
  const { data, error } = await supabase
    .from('inbox_conversations')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('updated_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as InboxConversation[];
}

export async function listInboxMessages(workspaceId: string, conversationId: string): Promise<InboxMessage[]> {
  const { data, error } = await supabase
    .from('inbox_messages')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) throw error;
  return (data ?? []) as InboxMessage[];
}

export async function markInboxConversationRead(conversationId: string): Promise<void> {
  const { error } = await supabase
    .from('inbox_conversations')
    .update({ unread: false })
    .eq('id', conversationId);
  if (error) throw error;
}

export async function sendInboxReply(conversationId: string, content: string): Promise<InboxMessage> {
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  if (!token) throw new Error('يجب تسجيل الدخول لإرسال الرد');

  const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/inbox-reply`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
    },
    body: JSON.stringify({ conversationId, content: content.trim() }),
  });

  let body: { error?: string; message?: InboxMessage } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // handled by the status-based error below
  }
  if (!response.ok || !body.message) {
    throw new Error(body.error ?? `تعذّر إرسال الرد (${response.status})`);
  }
  return body.message;
}


export type AccountSyncResult = {
  account_id: string;
  platform: string;
  ok: boolean;
  status: 'connected' | 'error' | 'expired';
  handle?: string;
  display_name?: string;
  error?: string;
};

export async function syncAccounts(workspaceId: string): Promise<{ synced: number; results: AccountSyncResult[] }> {
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  if (!token) throw new Error('يجب تسجيل الدخول لمزامنة الحسابات');

  const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/account-sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
    },
    body: JSON.stringify({ workspace_id: workspaceId }),
  });

  const body = await response.json().catch(() => ({})) as { error?: string; synced?: number; results?: AccountSyncResult[] };
  if (!response.ok) throw new Error(body.error ?? `فشلت مزامنة الحسابات (${response.status})`);
  return { synced: Number(body.synced ?? 0), results: body.results ?? [] };
}

export async function syncAccount(accountId: string): Promise<AccountSyncResult> {
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  if (!token) throw new Error('يجب تسجيل الدخول لمزامنة الحساب');

  const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/account-sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
    },
    body: JSON.stringify({ account_id: accountId }),
  });

  const body = await response.json().catch(() => ({})) as { error?: string; results?: AccountSyncResult[] };
  if (!response.ok || !body.results?.[0]) throw new Error(body.error ?? `فشلت مزامنة الحساب (${response.status})`);
  return body.results[0];
}
