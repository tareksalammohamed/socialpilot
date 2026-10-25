import { DurableSteps, CHECKPOINT_YIELD } from '../functions/_shared/durable-steps.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';

function assert(value: unknown, message: string) { if (!value) throw new Error(message); }
function mockDb(owned: boolean | (()=>boolean) = true) {
  const writes: Record<string, unknown>[] = [];
  const filters: [string, unknown][] = [];
  const query = { eq: (key: string, value: unknown) => { filters.push([key,value]); return query; }, select: () => query,
    maybeSingle: () => Promise.resolve({ data: (typeof owned==='function'?owned():owned) ? { id: 'task' } : null, error: null }) };
  return { writes, filters, client: { from: () => ({ select: () => query, update: (row: Record<string, unknown>) => { writes.push(row); return query; } }) } as unknown as SupabaseClient };
}
Deno.test('AI stages persist, yield and resume without generating or charging twice', async () => {
  const db = mockDb(); let calls = 0;
  const cache: Record<string, unknown> = {};
  const stage = new DurableSteps(db.client,'task','lease',cache);
  try { await stage.run('write',async () => { calls++; return { text:'draft' }; }); throw new Error('did not yield'); }
  catch(error) { assert((error as Error).message===CHECKPOINT_YIELD,'wrong yield'); }
  assert(db.writes.filter(w => 'ai_steps' in w).length===1,'checkpoint not persisted');
  const resumed = new DurableSteps(db.client,'task','new-lease',cache);
  const result = await resumed.run('write',async () => { calls++; return {text:'duplicate'}; });
  assert(calls===1 && result.text==='draft','cached generation repeated');
  assert(db.filters.some(([key,value]) => key==='worker_id' && value==='lease'),'unfenced checkpoint');
});
Deno.test('failed AI step is not cached and can be retried', async () => {
  const db=mockDb(); const cache: Record<string,unknown>={};
  try { await new DurableSteps(db.client,'task','worker',cache).run('quality',async () => { throw new Error('provider unavailable'); }); } catch { /* expected */ }
  assert(!Object.hasOwn(cache,'quality') && db.writes.filter(w => 'ai_steps' in w).length===0,'error cached');
});
Deno.test('worker that lost its lease cannot save a checkpoint', async () => {
  try { await new DurableSteps(mockDb(false).client,'task','expired',{}).run('write',async () => 'draft'); throw new Error('accepted stale write'); }
  catch(error) { assert((error as Error).message==='lease_lost','stale checkpoint accepted'); }
});

Deno.test('cancelled task cannot use a cached step or start another model', async () => {
  let calls = 0;
  try { await new DurableSteps(mockDb(false).client, 'task', 'old-worker', { write: 'cached' }).run('write', async () => { calls++; return 'new'; }); throw new Error('accepted cancelled task'); }
  catch (error) { assert((error as Error).message === 'lease_lost', 'wrong cancellation error'); }
  assert(calls === 0, 'cancelled work started');
});
Deno.test('progress records real stage and selected model under the lease', async () => {
  const db = mockDb(); const steps = new DurableSteps(db.client, 'task', 'worker', {});
  await steps.report({ phase: 'quality', label: 'review', current: 2, total: 7 });
  await steps.report({ provider: 'provider', model: 'model', attempt: 2 });
  const progress = db.writes[1].progress as Record<string, unknown>;
  assert(progress.label === 'review' && progress.current === 2 && progress.model === 'model', 'stage overwritten');
  assert(db.filters.some(([k,v]) => k === 'status' && v === 'running'), 'progress not fenced');
});

Deno.test('stage timing survives yields, cached replay and parent steps without double counting',async()=>{
 const db=mockDb(),cache:Record<string,unknown>={};let now=0,calls=0;
 const first=new DurableSteps(db.client,'task','worker',cache,()=>now);
 try{await first.run('llm:digest:0',async()=>{calls++;now=1500;await first.report({provider:'p',model:'a',attempt:1});await first.report({provider:'p',model:'a',attempt:1});await first.report({provider:'p',model:'b',attempt:2});return 'copy';},true,{phase:'generation',label:'writing'});}catch(e){assert((e as Error).message===CHECKPOINT_YIELD,'unexpected error');}
 const resumed=new DurableSteps(db.client,'task','worker-2',cache,()=>now);
 await resumed.run('tool:step-1',async()=>{const copy=await resumed.run('llm:digest:0',async()=>{calls++;return 'wrong';});now=9000;return copy;},false);
 const m=(cache.__execution_metrics_v1 as {phases:{generation:{duration_ms:number;completed:number;reported_model_attempts:number}}}).phases;
 assert(calls===1&&m.generation.duration_ms===1500&&m.generation.completed===1&&m.generation.reported_model_attempts===2,'replay or parent double counted');
 const progress=db.writes.at(-1)?.progress as Record<string,unknown>;
 assert(Boolean(progress.metrics),'metrics missing from visible progress');
});
Deno.test('failed measured work records timing without caching its result, then retries safely',async()=>{
 const db=mockDb(),cache:Record<string,unknown>={};let now=0;
 const step=new DurableSteps(db.client,'task','worker',cache,()=>now);
 try{await step.run('planner',async()=>{now=100;throw Error('provider');});}catch{/* retry */}
 assert(!Object.hasOwn(cache,'planner'),'failure cached as success');
 await step.run('planner',async()=>{now=350;return 'plan';},false);
 const m=(cache.__execution_metrics_v1 as {phases:{planning:{duration_ms:number;completed:number;failed:number}}}).phases.planning;
 assert(m.duration_ms===350&&m.failed===1&&m.completed===1,'retry timings lost');
});
Deno.test('progress heartbeats do not reset the start of a stage',async()=>{
 const db=mockDb(),steps=new DurableSteps(db.client,'task','worker',{});
 await steps.report({phase:'quality',label:'review'});
 const started=(db.writes[0].progress as Record<string,unknown>).phase_started_at;
 await steps.report({provider:'p',model:'a',attempt:1});
 assert((db.writes[1].progress as Record<string,unknown>).phase_started_at===started,'heartbeat reset stage clock');
});

Deno.test('losing the lease after work cannot persist a result or its metrics',async()=>{
 for(const fail of [false,true]){
  let owned=true;const db=mockDb(()=>owned),cache:Record<string,unknown>={};
  try{await new DurableSteps(db.client,'task','old-worker',cache).run('planner',async()=>{owned=false;if(fail)throw Error('provider');return 'late';},false);throw Error('late save accepted');}
  catch(error){assert((error as Error).message==='lease_lost','wrong stale worker outcome');}
  assert(!Object.hasOwn(cache,'planner')&&!Object.hasOwn(cache,'__execution_metrics_v1'),'stale telemetry cached');
 }
});
