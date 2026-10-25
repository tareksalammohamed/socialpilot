import { runAgentTurn } from '../functions/ai-gateway/agent/pipeline.ts';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import type { AgentRequest } from '../functions/ai-gateway/agent/types.ts';
import { creationDefaults } from '../functions/_shared/creation-policy.ts';

Deno.test('weekly draft executes the real tool bridge without asking or calling an AI planner',async()=>{
 const req:AgentRequest=creationDefaults({message:'اعمل حملة أسبوع',context:{workspaceId:'workspace',userId:'user',currentRoute:'create'}},['facebook'],new Date('2026-10-04T12:00:00Z'));
 let calls=0;
 const db={from:()=>{throw new Error('unexpected planner/database read');}} as unknown as SupabaseClient;
 const result=await runAgentTurn(db,req,async(intent,message,platforms,context)=>{
  calls++;
  if(intent!=='create_content_plan'||message!==req.message||platforms[0]!=='facebook'||context.post_count!==7)throw new Error('wrong creation tool inputs');
  return {result:{theme:'Campaign',slots:[]},tokensIn:0,tokensOut:0};
 });
 if(calls!==1||result.clarifyingQuestion||result.pendingApproval||!result.toolResults[0].ok)throw new Error('creation blocked');
 if(!result.toolResults[0].output?.creation_assumptions)throw new Error('defaults not disclosed');
});
Deno.test('a follow-up edits the existing campaign and removes Instagram in the real tool pipeline',async()=>{
 let saved=false;
 const posts=[{id:'post',title:'التأمين'}];
 const rows=[{id:'li',content_id:'post',platform:'linkedin',text:'النص الموجود',hashtags:[],cta:null,status:'review',updated_at:'2026-10-05T10:00:00Z',scheduled_at:null},{id:'ig',content_id:'post',platform:'instagram',text:'نسخة انستجرام',hashtags:[],cta:null,status:'review',updated_at:'2026-10-05T10:00:00Z',scheduled_at:null}];
 const db={from:(table:string)=>{
   const query:Record<string,unknown>={};for(const key of ['select','eq','in'])query[key]=()=>query;
   query.order=()=>Promise.resolve({data:table==='content'?posts:rows,error:null});return query;
 },rpc:(name:string,args:Record<string,unknown>)=>{
  const updates=args.p_updates as Array<Record<string,unknown>>;
  if(name!=='apply_editorial_revision'||updates.length!==1||updates[0].id!=='li'||updates[0].platform!=='linkedin'||JSON.stringify(args.p_remove_ids)!=='["ig"]')throw Error('wrong existing targets');
  saved=true;return Promise.resolve({data:{updated:1,removed:1},error:null});
 }} as unknown as SupabaseClient;
 const out=await runAgentTurn(db,{message:'خليها لينكد ان بس وامسح نسخه انستقرام',context:{workspaceId:'workspace',userId:'user',selectedCampaignId:'batch'}},async(intent,_message,platforms,context)=>{
  if(intent!=='create_content_plan'||platforms[0]!=='linkedin'||!(context.existing_slots as unknown[])?.length)throw Error('existing context missing');
  return {result:{slots:[{title:'التأمين',platform:'linkedin',content:'قبل ما تختار تأمين، اسأل إيه الشروط اللي محتاج تفهمها عشان تاخد قرار مناسب.',quality:{verdict:'pass',scores:{overall:85},reasons:[],suggested_improvements:[]}}]},tokensIn:1,tokensOut:1};
 });
 if(!saved||out.pendingApproval||out.clarifyingQuestion||!out.toolResults[0].ok)throw Error('follow-up not executed');
});

Deno.test('real revision executor respects platform exclusions and multiple retained platforms',async()=>{
 for(const [message,expected] of [['شيل انستجرام',['facebook','linkedin']],['خليها فيسبوك ولينكد ان بس',['facebook','linkedin']],['اختصره',['facebook','linkedin','instagram']]] as Array<[string,string[]]>) {
  let written=false,calls=0;
  const rows=['facebook','linkedin','instagram'].map(platform=>({id:platform,content_id:'post',platform,text:'النص الحالي '+platform,hashtags:[],cta:null,status:'review',updated_at:'2026-10-25T10:00:00Z',scheduled_at:null}));
  const db={from:(table:string)=>{
   const q:Record<string,unknown>={};for(const key of ['select','eq','in'])q[key]=()=>q;
   q.order=()=>Promise.resolve({data:table==='content'?[{id:'post',title:'الفكرة'}]:rows,error:null});return q;
  },rpc:(_name:string,args:Record<string,unknown>)=>{
   const updates=args.p_updates as Array<Record<string,unknown>>;
   if(JSON.stringify(updates.map(r=>r.platform))!==JSON.stringify(expected)||updates.some(r=>r.id!==r.platform))throw Error('wrong targets');
   if(JSON.stringify(args.p_remove_ids)!==JSON.stringify(rows.filter(r=>!expected.includes(r.platform)).map(r=>r.id)))throw Error('wrong removals');
   written=true;return Promise.resolve({data:{},error:null});
  }} as unknown as SupabaseClient;
  const out=await runAgentTurn(db,{message,context:{workspaceId:'ws',userId:'user',currentContentId:'post'}},async(_intent,_message,platforms,ctx)=>{
   calls++;if(JSON.stringify(platforms)!==JSON.stringify(expected)||(ctx.existing_slots as unknown[]).length!==expected.length)throw Error('wrong writer scope');
   return {result:{slots:platforms.map(platform=>({platform,title:'الفكرة',content:'صياغة بالمصري'}))},tokensIn:0,tokensOut:0};
  });
  if(!written||calls!==1||!out.toolResults[0].ok||out.clarifyingQuestion)throw Error('edit failed: '+message);
 }
});
Deno.test('empty platform scope and malformed results never save a partial revision',async()=>{
 for(const mode of ['remove-all','missing-slot','wrong-platform']) {
  let writes=0,calls=0;
  const db={from:(table:string)=>{
   const q:Record<string,unknown>={};for(const key of ['select','eq','in'])q[key]=()=>q;
   q.order=()=>Promise.resolve({data:table==='content'?[{id:'post',title:'الفكرة'}]:[{id:'li',content_id:'post',platform:'linkedin',text:'النص الحالي',hashtags:[],cta:null,status:'review',updated_at:'2026-10-25T10:00:00Z',scheduled_at:null}],error:null});return q;
  },rpc:()=>{writes++;return Promise.resolve({data:{},error:null});}} as unknown as SupabaseClient;
  let rejected=false;
  try {await runAgentTurn(db,{message:mode==='remove-all'?'شيل لينكد ان':'اختصره',context:{workspaceId:'ws',userId:'user',currentContentId:'post'}},async()=>{
    calls++;return {result:{slots:mode==='missing-slot'?[]:[{platform:'instagram',title:'الفكرة',content:'نص مختلف'}]},tokensIn:0,tokensOut:0};
  });}catch{rejected=true;}
  if(!rejected||writes!==0||(mode==='remove-all'&&calls!==0))throw Error('unsafe revision: '+mode);
 }
});

Deno.test('a selected variant in a multi-post campaign does not require editing other posts',async()=>{
 let selected=false,written=false;
 const row={id:'chosen',content_id:'second',platform:'linkedin',text:'النص الحالي',hashtags:[],cta:null,status:'review',updated_at:'2026-10-25T10:00:00Z',scheduled_at:null};
 const db={from:(table:string)=>{
  const q:Record<string,unknown>={};for(const key of ['select','in'])q[key]=()=>q;
  q.eq=(field:string,value:string)=>{if(table==='content_variants'&&field==='id'&&value==='chosen')selected=true;return q;};
  q.order=()=>q; q.then=(resolve:(value:unknown)=>unknown)=>resolve({data:table==='content'?[{id:'first',title:'الأول'},{id:'second',title:'الثاني'}]:[row],error:null});return q;
 },rpc:(_name:string,args:Record<string,unknown>)=>{
  const updates=args.p_updates as Array<Record<string,unknown>>;
  if(!selected||updates.length!==1||updates[0].id!=='chosen'||(args.p_remove_ids as string[]).length)throw Error('variant scope lost');
  written=true;return Promise.resolve({data:{},error:null});
 }} as unknown as SupabaseClient;
 await runAgentTurn(db,{message:'اختصره',context:{workspaceId:'ws',userId:'user',selectedCampaignId:'batch',currentVariantId:'chosen'}},async()=>({result:{slots:[{platform:'linkedin',title:'الثاني',content:'صياغة مختصرة'}]},tokensIn:0,tokensOut:0}));
 if(!written)throw Error('selected variant not saved');
});
