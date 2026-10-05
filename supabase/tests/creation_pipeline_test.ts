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
