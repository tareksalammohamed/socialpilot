import { supabase } from './supabase';
import type { CalendarItem, Content, ContentStatus, SocialAccount } from './types';

export const CONTENT_PAGE_SIZE = 24;
export type ContentFilter = ContentStatus | 'all';
export type ContentPreview = Pick<Content, 'id' | 'title' | 'master_text'>;

export async function loadContentPage(workspaceId: string, page: number, status: ContentFilter, search: string) {
  let query = supabase.from('content').select('*', { count: 'exact' }).eq('workspace_id', workspaceId);
  if (status !== 'all') query = query.eq('status', status);
  const term = search.trim();
  if (term) query = query.ilike('title', `%${term.replace(/[\\%_]/g, '\\$&')}%`);
  const { data, count, error } = await query.order('created_at', { ascending: false })
    .order('id', { ascending: false }).range(page * CONTENT_PAGE_SIZE, (page + 1) * CONTENT_PAGE_SIZE - 1);
  if (error) throw error;
  return { items: (data ?? []) as Content[], total: count ?? 0 };
}

export async function loadContentSummary(workspaceId: string) {
  const base = () => supabase.from('content').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId);
  const [all, review, published, scheduled, accounts] = await Promise.all([
    base(), base().or('status.eq.review,quality_status.eq.needs_improvement'), base().eq('status', 'published'),
    supabase.from('calendar_items').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId).in('status', ['planned', 'scheduled', 'publishing']),
    supabase.from('social_accounts').select('*').eq('workspace_id', workspaceId),
  ]);
  const error = all.error ?? review.error ?? published.error ?? scheduled.error ?? accounts.error;
  if (error) throw error;
  return { total: all.count ?? 0, review: review.count ?? 0, published: published.count ?? 0, scheduled: scheduled.count ?? 0, accounts: (accounts.data ?? []) as SocialAccount[] };
}

/** Match the browser-local week used by the calendar's day/time inputs. */
export function calendarWeek(offset: number, now = new Date()) {
  const start = new Date(now);
  start.setDate(start.getDate() - start.getDay() + offset * 7);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 7);
  const days = Array.from({ length: 7 }, (_, index) => { const day = new Date(start); day.setDate(day.getDate() + index); return day; });
  return { start, end, days };
}

export async function loadCalendarWeek(workspaceId: string, offset: number) {
  const { start, end } = calendarWeek(offset);
  const items: CalendarItem[] = [];
  const previews = new Map<string, ContentPreview>();
  for (let page = 0; ; page++) {
    const { data, error } = await supabase.from('calendar_items').select('*,content(id,title,master_text)')
      .eq('workspace_id', workspaceId).gte('scheduled_for', start.toISOString()).lt('scheduled_for', end.toISOString())
      .order('scheduled_for', { ascending: true }).order('id', { ascending: true }).range(page * 200, (page + 1) * 200 - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as (CalendarItem & { content: ContentPreview | null })[];
    for (const row of rows) {
      items.push(row);
      if (row.content) previews.set(row.content.id, row.content);
    }
    if (rows.length < 200) break;
  }
  return { items, content: [...previews.values()] };
}

/** Never infer publication identity from the currently displayed week/page. */
export async function findVariantCalendar(workspaceId: string, variantId: string) {
  const { data, error } = await supabase.from('calendar_items').select('id,status')
    .eq('workspace_id', workspaceId).eq('variant_id', variantId).neq('status', 'cancelled')
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw error;
  return data as { id: string; status: string } | null;
}
