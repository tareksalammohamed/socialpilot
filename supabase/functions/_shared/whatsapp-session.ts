export function disconnectedAccount(metadata: Record<string, unknown>, now = new Date().toISOString()) {
  return {
    status: 'error',
    needs_reconnect: true,
    last_sync_at: now,
    metadata: { ...metadata, provider_state: 'disconnected', onboarding_state: 'disconnected', disconnected_at: now },
    updated_at: now,
  };
}

export function isWppConnected(value: unknown): boolean {
  const state = String(value ?? '').trim().toLowerCase().replace(/[\s_-]+/g, '');
  return ['connected', 'islogged', 'logged', 'open', 'inchat', 'ischat'].includes(state);
}

// A failed logout must never be treated as permission to start a second provider.
export async function closeSession(url: string, init: RequestInit): Promise<void> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(12000) });
  const body = await response.json().catch(() => null);
  if ((!response.ok && response.status !== 404) || (response.ok && body?.status === false)) {
    throw new Error(`تعذّر إغلاق جلسة WhatsApp القديمة (HTTP ${response.status})؛ لم يتم التحويل`);
  }
}
