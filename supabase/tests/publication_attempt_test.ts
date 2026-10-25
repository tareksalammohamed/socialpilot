import { PublicationAttempt, UncertainPublicationError, findPublicationHold, UNCERTAIN_PUBLICATION } from '../functions/_shared/publication-attempt.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';

function database(options: { failDispatch?: boolean; failConfirm?: boolean; hold?: Record<string, unknown> } = {}) {
  const writes: Record<string, unknown>[] = [], filters: unknown[][] = [];
  const db = { from: () => {
    let patch: Record<string, unknown> | undefined;
    const query: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'in', 'limit']) query[method] = (...args: unknown[]) => { filters.push([method, ...args]); return query; };
    query.update = (value: Record<string, unknown>) => { patch = value; writes.push(value); return query; };
    query.maybeSingle = () => query;
    query.then = (resolve: (value: unknown) => unknown) => {
      const outcome = (patch?.result as Record<string, unknown>)?.outcome;
      const failed = outcome === 'dispatching' && options.failDispatch || outcome === 'confirmed' && options.failConfirm;
      return Promise.resolve({ data: failed ? null : patch ? { id: 'job' } : options.hold ?? null, error: failed ? { message: 'database unavailable' } : null }).then(resolve);
    };
    return query;
  } } as unknown as SupabaseClient;
  return { db, writes, filters };
}

for (const scenario of ['network', 'server', 'timeout', 'malformed', 'missing-id']) {
  Deno.test(`publication ${scenario} does not replay and is classified uncertain`, async () => {
    const saved = globalThis.fetch;
    const { db, writes } = database(); let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls++;
      if ((writes[0]?.result as Record<string, unknown>)?.outcome !== 'dispatching') throw Error('send before durable marker');
      if (!init?.signal) throw Error('publication has no deadline');
      if (scenario === 'network') throw new TypeError('connection lost');
      if (scenario === 'malformed') return new Response('not JSON');
      return Response.json(scenario === 'missing-id' ? {} : { id: 'remote' }, { status: scenario === 'server' ? 503 : scenario === 'timeout' ? 408 : 200 });
    };
    try {
      const attempt = new PublicationAttempt(db, 'job');
      let error: unknown;
      try {
        await attempt.run(async () => {
          const response = await attempt.send('https://example.test/posts', { method: 'POST' });
          const body = await response.json();
          if (!response.ok) throw Error('upstream failure');
          return { id: body.id, url: null };
        });
      } catch (cause) { error = cause; }
      if (!(error instanceof UncertainPublicationError) || calls !== 1) throw Error('ambiguous request was replayed or lost');
    } finally { globalThis.fetch = saved; }
  });
}

Deno.test('a confirmed remote ID is persisted before returning success', async () => {
  const saved = globalThis.fetch; const { db, writes } = database();
  globalThis.fetch = async () => Response.json({ id: 'post-1' });
  try {
    const attempt = new PublicationAttempt(db, 'job');
    const result = await attempt.run(async () => ({ id: (await (await attempt.send('https://example.test', { method: 'POST' })).json()).id, url: null }));
    if (result.id !== 'post-1' || (writes[1].result as Record<string, unknown>).post_id !== 'post-1') throw Error('remote ID not saved');
  } finally { globalThis.fetch = saved; }
});

Deno.test('dispatch persistence failure prevents any external send', async () => {
  const saved = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ id: 'post' }); };
  try {
    const attempt = new PublicationAttempt(database({ failDispatch: true }).db, 'job');
    try { await attempt.run(async () => { await attempt.send('https://example.test', { method: 'POST' }); return { id: 'post', url: null }; }); }
    catch (error) { if (error instanceof UncertainPublicationError || calls !== 0) throw error; return; }
    throw Error('send allowed without durable marker');
  } finally { globalThis.fetch = saved; }
});

Deno.test('lost confirmation persistence remains uncertain after remote success', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ id: 'post' });
  try {
    const attempt = new PublicationAttempt(database({ failConfirm: true }).db, 'job');
    try { await attempt.run(async () => { await attempt.send('https://example.test', { method: 'POST' }); return { id: 'post', url: null }; }); }
    catch (error) { if (!(error instanceof UncertainPublicationError)) throw error; return; }
    throw Error('lost confirmation reported as safe to retry');
  } finally { globalThis.fetch = saved; }
});

Deno.test('an explicit platform rejection remains a definitive failure', async () => {
  const saved = globalThis.fetch; const { db, writes } = database();
  globalThis.fetch = async () => Response.json({ error: 'expired' }, { status: 401 });
  try {
    const attempt = new PublicationAttempt(db, 'job');
    try { await attempt.run(async () => { const r = await attempt.send('https://example.test', { method: 'POST' }); if (!r.ok) throw Error('expired'); return { id: 'post', url: null }; }); }
    catch (error) {
      if (error instanceof UncertainPublicationError || (writes[1].result as Record<string, unknown>).outcome !== 'rejected') throw error;
      return;
    }
    throw Error('rejection accepted');
  } finally { globalThis.fetch = saved; }
});

Deno.test('unresolved sends block every key for that workspace and variant', async () => {
  const { db, filters, writes } = database({ hold: { id: 'old-job', status: 'running', last_attempt_at: '2026-01-01T00:00:00Z' } });
  if (await findPublicationHold(db, 'workspace', 'variant') !== UNCERTAIN_PUBLICATION) throw Error('lost worker was not held');
  if (!filters.some(f => f[1] === 'workspace_id' && f[2] === 'workspace') || !filters.some(f => f[1] === 'variant_id' && f[2] === 'variant')) throw Error('hold lookup not scoped');
  if (writes[0]?.status !== 'failed') throw Error('stale running state not reconciled');
});

Deno.test('fresh dispatch is reported as running rather than failed', async () => {
  const { db, writes } = database({ hold: { id: 'job', status: 'running', last_attempt_at: new Date().toISOString() } });
  const message = await findPublicationHold(db, 'workspace', 'variant');
  if (!message?.includes('جارية') || writes.length) throw Error('active publication was failed');
});
