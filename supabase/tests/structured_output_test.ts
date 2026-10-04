import { validJson, validItems, stableStringify } from '../functions/_shared/structured-output.ts';
import { getAdapter } from '../functions/ai-gateway/providers.ts';
function assert(v: unknown) { if (!v) throw new Error('assertion failed'); }
const post={title:'كيف تختار التأمين',content:'اختيار التأمين يبدأ بفهم احتياجاتك ومراجعة الشروط والاستثناءات قبل التوقيع.'};
Deno.test('truncated campaign cannot be salvaged from its complete inner slots',()=>{
 assert(!validJson('{"theme":"test","slots":['+JSON.stringify(post)+',{"content":"قطع'));
 assert(!validItems(JSON.stringify({slots:[post]}),'slots',7));
 assert(!validItems(JSON.stringify({slots:[{title:'منشور 1',content:''}]}),'slots',1));
 assert(validItems(JSON.stringify({slots:Array.from({length:7},()=>post)}),'slots',7));
});
Deno.test('quality and improvements use complete object envelopes with matching counts',()=>{
 const q={verdict:'pass',scores:{overall:85},reasons:[],suggested_improvements:[]};
 assert(!validItems(JSON.stringify(q),'reviews',7,true));
 assert(!validItems(JSON.stringify({reviews:[{...q,scores:{}}]}),'reviews',1,true));
 assert(!validItems(JSON.stringify({reviews:[{...q,scores:{overall:NaN}}]}),'reviews',1,true));
 assert(validItems(JSON.stringify({reviews:[q]}),'reviews',1,true));
 assert(validItems(JSON.stringify({posts:[post]}),'posts',1));
});
Deno.test('durable digests survive JSONB key reordering but separate changed requests',()=>{
 assert(stableStringify({schedule:{time:'09:00',dates:['2026-10-04']},count:7})===stableStringify({count:7,schedule:{dates:['2026-10-04'],time:'09:00'}}));
 assert(stableStringify({count:7})!==stableStringify({count:8}));
});
Deno.test('adapter sends campaign token budget and rejects length-truncated answers',async()=>{
 const saved=globalThis.fetch;
 let budget=0;
 globalThis.fetch=async(_url,init)=>{ budget=JSON.parse(String(init?.body)).max_tokens; return Response.json({choices:[{finish_reason:'length',message:{content:JSON.stringify({slots:[post]})}}]}); };
 try {
  let rejected=false;
  try {await getAdapter('openai')!.chatComplete('test','model','sys','user',true,undefined,undefined,7000);} catch {rejected=true;}
  assert(budget===7000 && rejected);
 } finally {globalThis.fetch=saved;}
});

Deno.test('Arabic campaigns reject foreign-script contamination while other language requests remain allowed',()=>{
 const foreign={...post,content:post.content+'记住'};
 assert(!validItems(JSON.stringify({slots:[foreign]}),'slots',1,false,true));
 assert(validItems(JSON.stringify({slots:[post]}),'slots',1,false,true));
 assert(validItems(JSON.stringify({slots:[foreign]}),'slots',1,false,false));
});

Deno.test('pass with a ten-point score cannot be mistaken for a valid hundred-point review',()=>{
 const q={verdict:'pass',scores:{hook:7,overall:8},reasons:[],suggested_improvements:[]};
 assert(!validItems(JSON.stringify({reviews:[q]}),'reviews',1,true));
 assert(validItems(JSON.stringify({reviews:[{...q,scores:{hook:70,overall:80}}]}),'reviews',1,true));
});

Deno.test('provider call propagates cancellation so fallback does not hang',async()=>{
 const saved=globalThis.fetch;
 globalThis.fetch=async(_url,init)=>{
  if(!init?.signal)throw new Error('missing timeout signal');
  return await new Promise<Response>((_resolve,reject)=>{
   const signal=init.signal!;
   if(signal.aborted)reject(signal.reason);else signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  });
 };
 try {
  const controller=new AbortController();
  const request=getAdapter('openai')!.chatComplete('test','model','','',true,undefined,undefined,7000,controller.signal);
  controller.abort(new Error('test timeout'));
  let rejected=false;try {await request;}catch(e){rejected=e instanceof Error&&e.message==='test timeout';}
  assert(rejected);
 }finally{globalThis.fetch=saved;}
});

Deno.test('Arabic quality explanations reject foreign-script contamination too',()=>{
 const q={verdict:'pass',scores:{overall:85},reasons:['نص جيد например'],suggested_improvements:[]};
 assert(!validItems(JSON.stringify({reviews:[q]}),'reviews',1,true,true));
});
