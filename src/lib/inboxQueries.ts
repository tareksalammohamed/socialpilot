import { supabase } from './supabase';
import type { InboxConversation, InboxMessage } from './types';

export const INBOX_PAGE_SIZE = 30;
export const MESSAGE_PAGE_SIZE = 50;
export type MessageCursor = Pick<InboxMessage, 'id' | 'created_at'>;
export type InboxFilter = { search: string; status: 'all' | 'open' | 'pending' | 'closed'; platform: string; page: number };
const quoted = (value: string) => JSON.stringify(value);
const literalLike = (value: string) => value.replace(/[\\%_]/g, '\\$&');

export async function loadInboxPage(workspaceId: string, filter: InboxFilter) {
  let query = supabase.from('inbox_conversations').select('*', { count: 'exact' }).eq('workspace_id', workspaceId);
  if (filter.status !== 'all') query = query.eq('status', filter.status);
  if (filter.platform !== 'all') query = query.eq('platform', filter.platform);
  if (filter.search.trim()) {
    const pattern = quoted(`%${literalLike(filter.search.trim())}%`);
    query = query.or(`sender_name.ilike.${pattern},snippet.ilike.${pattern}`);
  }
  const { data, count, error } = await query.order('updated_at', { ascending: false }).order('id', { ascending: false })
    .range(filter.page * INBOX_PAGE_SIZE, (filter.page + 1) * INBOX_PAGE_SIZE - 1).abortSignal(AbortSignal.timeout(20_000));
  if (error) throw error;
  return { items: (data ?? []) as InboxConversation[], total: count ?? 0 };
}

export async function loadInboxSummary(workspaceId: string) {
  const base = () => supabase.from('inbox_conversations').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId).abortSignal(AbortSignal.timeout(20_000));
  const [unread, open, review, accounts] = await Promise.all([
    base().eq('unread', true), base().eq('status', 'open'), base().eq('needs_review', true),
    supabase.from('social_accounts').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId).eq('status', 'connected').abortSignal(AbortSignal.timeout(20_000)),
  ]);
  const error = unread.error ?? open.error ?? review.error ?? accounts.error;
  if (error) throw error;
  return { unread: unread.count ?? 0, open: open.count ?? 0, review: review.count ?? 0, accounts: accounts.count ?? 0 };
}

export async function loadMessagePage(workspaceId: string, conversationId: string, before?: MessageCursor) {
  let query = supabase.from('inbox_messages').select('*').eq('workspace_id', workspaceId).eq('conversation_id', conversationId);
  if (before) {
    query = query.or(`created_at.lt.${quoted(before.created_at)},and(created_at.eq.${quoted(before.created_at)},id.lt.${quoted(before.id)})`);
  }
  const { data, error } = await query.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(MESSAGE_PAGE_SIZE + 1).abortSignal(AbortSignal.timeout(20_000));
  if (error) throw error;
  const rows = ((data ?? []) as InboxMessage[]).slice(0, MESSAGE_PAGE_SIZE).reverse();
  return { items: rows, hasMore: (data?.length ?? 0) > MESSAGE_PAGE_SIZE, cursor: rows[0] ? { id: rows[0].id, created_at: rows[0].created_at } : null };
}

/** Existing live rows win over an older page/snapshot, including delivery updates. */
export function mergeInboxMessages(loaded: InboxMessage[], current: InboxMessage[]) {
  const rows = new Map(loaded.map(row => [row.id, row]));
  for (const row of current) rows.set(row.id, row);
  return [...rows.values()].sort((a, b) => {
    const millis = Date.parse(a.created_at) - Date.parse(b.created_at);
    if (millis) return millis;
    const fraction = (value: string) => (value.match(/\.(\d+)/)?.[1] ?? '').padEnd(6, '0').slice(0, 6);
    const af = fraction(a.created_at), bf = fraction(b.created_at);
    if (af !== bf) return af < bf ? -1 : 1;
    return a.id === b.id ? 0 : a.id < b.id ? -1 : 1;
  });
}
