import { supabase } from './supabase';
import type { AiGatewayRequest, AiGatewayResponse, InboxConversation, InboxMessage, InboxAiAnalysis, AgentContext, AgentTurnResult, AgentToolResult } from './types';

export async function startSocialOAuth(workspaceId: string, platformKey: 'meta' | 'linkedin' | 'x' | 'threads' | 'tiktok' = 'meta'): Promise<string> {
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

export type WhatsAppEmbeddedConfig = {
  configured: true;
  appId: string;
  configurationId: string;
  graphVersion: string;
};

export type WhatsAppEmbeddedResult = {
  ok: true;
  needsRegistration: boolean;
  account: {
    id: string;
    display_name: string | null;
    handle: string | null;
    status: string;
  };
};

async function callWhatsAppEmbedded<T>(payload: Record<string, unknown>): Promise<T> {
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  if (!token) throw new Error('يجب تسجيل الدخول لربط واتساب');

  const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/whatsapp-embedded-signup`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error((body.error as string | undefined) ?? `فشل ربط واتساب (${response.status})`);
  return body as T;
}

export function getWhatsAppEmbeddedConfig(workspaceId: string): Promise<WhatsAppEmbeddedConfig> {
  return callWhatsAppEmbedded<WhatsAppEmbeddedConfig>({ action: 'get_config', workspaceId });
}

export function completeWhatsAppEmbeddedSignup(params: {
  workspaceId: string;
  code: string;
  wabaId?: string;
  phoneNumberId?: string;
}): Promise<WhatsAppEmbeddedResult> {
  return callWhatsAppEmbedded<WhatsAppEmbeddedResult>({ action: 'complete', ...params });
}

export function registerWhatsAppEmbeddedNumber(workspaceId: string, pin: string): Promise<{ ok: true }> {
  return callWhatsAppEmbedded<{ ok: true }>({ action: 'register', workspaceId, pin });
}

export type SocialIntegrationStatus = {
  platform_key: string;
  display_name: string;
  enabled: boolean;
  configured: boolean;
  status: 'not_configured' | 'connected' | 'error';
  last_error: string | null;
};

export async function getSocialIntegrationStatus(workspaceId: string): Promise<{
  apps: SocialIntegrationStatus[];
  accounts: Array<{ id: string; platform: string; status: string; needs_reconnect: boolean; last_sync_at: string | null }>;
}> {
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  if (!token) throw new Error('يجب تسجيل الدخول لعرض حالة التكاملات');

  const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/social-integration-status`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
    },
    body: JSON.stringify({ workspaceId }),
  });
  const body = await response.json().catch(() => ({})) as {
    error?: string;
    apps?: SocialIntegrationStatus[];
    accounts?: Array<{ id: string; platform: string; status: string; needs_reconnect: boolean; last_sync_at: string | null }>;
  };
  if (!response.ok) throw new Error(body.error ?? `فشل تحميل حالة التكاملات (${response.status})`);
  return { apps: body.apps ?? [], accounts: body.accounts ?? [] };
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

export type WhatsAppTemplate = {
  id: string;
  name: string;
  language: string;
  category: string;
  status: string;
  body: string;
  variableCount: number;
  sendable: boolean;
  unsupportedReason: string | null;
};

async function authorizedFunctionFetch(path: string, init: RequestInit): Promise<Response> {
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  if (!token) throw new Error('يجب تسجيل الدخول لإكمال الطلب');
  return fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
      ...(init.headers ?? {}),
    },
  });
}

export async function listWhatsAppTemplates(conversationId: string): Promise<WhatsAppTemplate[]> {
  const response = await authorizedFunctionFetch('whatsapp-templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId }),
  });
  const body = await response.json().catch(() => ({})) as { error?: string; templates?: WhatsAppTemplate[] };
  if (!response.ok) throw new Error(body.error ?? `تعذّر تحميل قوالب واتساب (${response.status})`);
  return body.templates ?? [];
}

export async function sendWhatsAppTemplate(params: {
  conversationId: string;
  template: WhatsAppTemplate;
  variables: string[];
  preview: string;
}): Promise<InboxMessage> {
  const response = await authorizedFunctionFetch('inbox-reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId: params.conversationId,
      mode: 'template',
      template: {
        name: params.template.name,
        language: params.template.language,
        variables: params.variables,
        preview: params.preview,
      },
    }),
  });
  const body = await response.json().catch(() => ({})) as { error?: string; message?: InboxMessage };
  if (!response.ok || !body.message) {
    throw new Error(body.error ?? `تعذّر إرسال Template (${response.status})`);
  }
  return body.message;
}

export async function fetchInboxMedia(messageId: string): Promise<Blob> {
  const response = await authorizedFunctionFetch('inbox-media', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messageId }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `تعذّر تحميل ميديا الرسالة (${response.status})`);
  }
  return response.blob();
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

export async function analyzeInboxConversation(conversationId: string): Promise<InboxAiAnalysis> {
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  if (!token) throw new Error('يجب تسجيل الدخول لتحليل المحادثة');

  const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/inbox-ai`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
    },
    body: JSON.stringify({ conversationId }),
  });
  const body = await response.json().catch(() => ({})) as { error?: string; analysis?: InboxAiAnalysis };
  if (!response.ok || !body.analysis) throw new Error(body.error ?? `فشل تحليل المحادثة (${response.status})`);
  return body.analysis;
}

export async function setInboxReplyApproval(params: {
  conversationId: string;
  action: 'approve_reply' | 'reject_reply';
  reply?: string;
  rejectionReason?: string;
}): Promise<InboxAiAnalysis> {
  const { data: session } = await supabase.auth.getSession();
  const token = session.session?.access_token;
  if (!token) throw new Error('يجب تسجيل الدخول لاعتماد الرد');
  const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/inbox-ai`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string },
    body: JSON.stringify(params),
  });
  const body = await response.json().catch(() => ({})) as { error?: string; analysis?: InboxAiAnalysis };
  if (!response.ok || !body.analysis) throw new Error(body.error ?? `فشل تحديث اعتماد الرد (${response.status})`);
  return body.analysis;
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
