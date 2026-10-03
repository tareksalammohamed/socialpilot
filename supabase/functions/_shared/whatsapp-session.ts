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

export function wppConnectionState(body: Record<string, unknown>): string {
  if (typeof body.status === 'boolean') return body.status ? 'connected' : 'disconnected';
  return String(body.status ?? body.message ?? body.state ?? body.response ?? 'unknown').trim().toLowerCase();
}

// A failed logout must never be treated as permission to start a second provider.
export async function closeSession(url: string, init: RequestInit, allowMissing = true): Promise<void> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(12000) });
  const body = await response.json().catch(() => null);
  if ((!response.ok && !(allowMissing && response.status === 404)) || (response.ok && body?.status === false)) {
    throw new Error(`تعذّر إغلاق جلسة WhatsApp القديمة (HTTP ${response.status})؛ لم يتم التحويل`);
  }
}
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';

export function isWahaConnected(value: unknown): boolean {
  return String(value ?? '').trim().toLowerCase() === 'working';
}

export function eventObservedAt(value: unknown): string {
  if (value !== null && value !== undefined && value !== '') {
    const numeric = typeof value === 'number' ? value : Number(value);
    const date = Number.isFinite(numeric)
      ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
      : new Date(String(value));
    // Reject implausible/future source clocks rather than poisoning ordering.
    if (Number.isFinite(date.getTime()) && date.getTime() > 1e12 && date.getTime() <= Date.now() + 30_000) return date.toISOString();
  }
  return new Date().toISOString();
}

export async function applySessionState(client: SupabaseClient, accountId: string, secret: string,
  patch: Record<string, unknown>, observedAt: string, operationId: string | null = null) {
  const { data, error } = await client.rpc('whatsapp_apply_state', {
    p_account_id: accountId, p_secret: secret, p_patch: patch,
    p_observed_at: observedAt, p_operation_id: operationId,
  });
  if (error) throw new Error('تعذّر حفظ حالة جلسة WhatsApp');
  return data as Record<string, unknown> | null;
}
