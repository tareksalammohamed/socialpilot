import { supabase } from './supabase';
import type {
  AiProvider,
  AiProviderKey,
  AiModel,
  AiRoutingPolicy,
  AiRoutingPolicyValue,
  AiUsageSummary,
  SocialPlatformApp,
  SocialPlatformAppKey,
} from './types';

export async function checkIsSuperAdmin(): Promise<boolean> {
  const { data, error } = await supabase.rpc('is_super_admin');
  if (error) return false;
  return Boolean(data);
}

async function callAiAdmin<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const { data: session } = await supabase.auth.getSession();
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai-admin`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.session?.access_token ?? ''}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
    },
    body: JSON.stringify({ action, ...payload }),
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

export const aiAdmin = {
  listProviders: () => callAiAdmin<{ providers: AiProvider[] }>('list_providers'),
  listModels: (providerKey?: AiProviderKey) => callAiAdmin<{ models: AiModel[] }>('list_models', { providerKey }),
  getRoutingPolicy: () => callAiAdmin<{ policy: AiRoutingPolicy }>('get_routing_policy'),
  getUsageSummary: () => callAiAdmin<AiUsageSummary>('get_usage_summary'),
  addProvider: (providerKey: AiProviderKey, apiKey: string, baseUrl?: string) =>
    callAiAdmin<{ ok: true }>('add_provider', { providerKey, apiKey, baseUrl }),
  testConnection: (providerKey: AiProviderKey) =>
    callAiAdmin<{ ok: boolean; error?: string }>('test_connection', { providerKey }),
  discoverModels: (providerKey: AiProviderKey) =>
    callAiAdmin<{ ok: true; modelsDiscovered: number }>('discover_models', { providerKey }),
  setEnabled: (providerKey: AiProviderKey, enabled: boolean) =>
    callAiAdmin<{ ok: true }>('set_enabled', { providerKey, enabled }),
  setPriority: (providerKey: AiProviderKey, priority: number) =>
    callAiAdmin<{ ok: true }>('set_priority', { providerKey, priority }),
  setAllowPaid: (providerKey: AiProviderKey, allowPaid: boolean) =>
    callAiAdmin<{ ok: true }>('set_allow_paid', { providerKey, allowPaid }),
  removeProvider: (providerKey: AiProviderKey) =>
    callAiAdmin<{ ok: true }>('remove_provider', { providerKey }),
  setRoutingPolicy: (policy: AiRoutingPolicyValue, allowPaidFallback: boolean) =>
    callAiAdmin<{ ok: true }>('set_routing_policy', { policy, allowPaidFallback }),
};

async function callSocialAdmin<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  const { data: session } = await supabase.auth.getSession();
  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/social-platform-admin`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.session?.access_token ?? ''}`,
      apikey: import.meta.env.VITE_SUPABASE_ANON_KEY as string,
    },
    body: JSON.stringify({ action, ...payload }),
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

export const socialAdmin = {
  listApps: () => callSocialAdmin<{ apps: SocialPlatformApp[] }>('list_apps'),
  saveApp: (platformKey: SocialPlatformAppKey, appId: string, appSecret?: string, redirectUri?: string, configurationId?: string) =>
    callSocialAdmin<{ ok: true; redirectUri: string | null }>('save_app', { platformKey, appId, appSecret, redirectUri, configurationId }),
  setEnabled: (platformKey: SocialPlatformAppKey, enabled: boolean) =>
    callSocialAdmin<{ ok: true }>('set_enabled', { platformKey, enabled }),
  removeApp: (platformKey: SocialPlatformAppKey) =>
    callSocialAdmin<{ ok: true }>('remove_app', { platformKey }),
};

export const whatsappProviderAdmin = {
  list: async () => {
    const result = await callSocialAdmin<{ apps: SocialPlatformApp[] }>('list_apps');
    const whatsapp = result.apps.find((app) => app.platform_key === 'whatsapp');
    return {
      providers: whatsapp?.whatsapp_providers ?? [],
      activeProvider: whatsapp?.active_provider ?? null,
    };
  },
  save: (
    providerKey: import('@/lib/types').WhatsAppProviderKey,
    baseUrl: string,
    secret?: string,
    priority?: number,
  ) => callSocialAdmin<{
    ok: true;
    activeProvider: import('@/lib/types').WhatsAppProviderKey | null;
    provider: import('@/lib/types').WhatsAppProviderConfig;
  }>('save_whatsapp_provider', {
    providerKey,
    baseUrl,
    credential: secret,
    enabled: true,
    priority,
  }),
  testAll: () => callSocialAdmin<{
    ok: true;
    activeProvider: import('@/lib/types').WhatsAppProviderKey | null;
    providers: import('@/lib/types').WhatsAppProviderConfig[];
  }>('test_whatsapp_providers'),
  setEnabled: (providerKey: import('@/lib/types').WhatsAppProviderKey, enabled: boolean) =>
    callSocialAdmin<{
      ok: true;
      activeProvider: import('@/lib/types').WhatsAppProviderKey | null;
    }>('set_whatsapp_provider_enabled', { providerKey, enabled }),
  setActive: (providerKey: import('@/lib/types').WhatsAppProviderKey) =>
    callSocialAdmin<{
      ok: true;
      activeProvider: import('@/lib/types').WhatsAppProviderKey;
    }>('set_whatsapp_active_provider', { providerKey }),
  remove: (providerKey: import('@/lib/types').WhatsAppProviderKey) =>
    callSocialAdmin<{
      ok: true;
      activeProvider: import('@/lib/types').WhatsAppProviderKey | null;
    }>('remove_whatsapp_provider', { providerKey }),
};

