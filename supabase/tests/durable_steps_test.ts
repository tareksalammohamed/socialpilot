import { DurableSteps, CHECKPOINT_YIELD } from '../functions/_shared/durable-steps.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';

function assert(value: unknown, message: string) { if (!value) throw new Error(message); }
function mockDb(owned = true) {
  const writes: Record<string, unknown>[] = [];
  const filters: [string, unknown][] = [];
  const query = { eq: (key: string, value: unknown) => { filters.push([key,value]); return query; }, select: () => query,
    maybeSingle: () => Promise.resolve({ data: owned ? { id: 'task' } : null, error: null }) };
  return { writes, filters, client: { from: () => ({ update: (row: Record<string, unknown>) => { writes.push(row); return query; } }) } as unknown as SupabaseClient };
}
Deno.test('AI stages persist, yield and resume without generating or charging twice', async () => {
  const db = mockDb(); let calls = 0;
  const cache: Record<string, unknown> = {};
  const stage = new DurableSteps(db.client,'task','lease',cache);
  try { await stage.run('write',async () => { calls++; return { text:'draft' }; }); throw new Error('did not yield'); }
  catch(error) { assert((error as Error).message===CHECKPOINT_YIELD,'wrong yield'); }
  assert(db.writes.length===1,'checkpoint not persisted');
  const resumed = new DurableSteps(db.client,'task','new-lease',cache);
  const result = await resumed.run('write',async () => { calls++; return {text:'duplicate'}; });
  assert(calls===1 && result.text==='draft','cached generation repeated');
  assert(db.filters.some(([key,value]) => key==='worker_id' && value==='lease'),'unfenced checkpoint');
});
Deno.test('failed AI step is not cached and can be retried', async () => {
  const db=mockDb(); const cache: Record<string,unknown>={};
  try { await new DurableSteps(db.client,'task','worker',cache).run('quality',async () => { throw new Error('provider unavailable'); }); } catch { /* expected */ }
  assert(!Object.hasOwn(cache,'quality') && db.writes.length===0,'error cached');
});
Deno.test('worker that lost its lease cannot save a checkpoint', async () => {
  try { await new DurableSteps(mockDb(false).client,'task','expired',{}).run('write',async () => 'draft'); throw new Error('accepted stale write'); }
  catch(error) { assert((error as Error).message==='lease_lost','stale checkpoint accepted'); }
});
