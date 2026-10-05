import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';
import type { AgentContext, ToolCall, ToolResult } from './types.ts';
import type { LegacyRunner } from './executors.ts';
import type { DurableSteps } from '../../_shared/durable-steps.ts';
import { exclusivePlatform } from '../../_shared/editorial-followup.ts';

type Row={id:string;content_id:string;platform:string;text:string;hashtags:string[];cta:string|null;status:string;updated_at:string;scheduled_at:string|null};
export async function executeRevision(call:ToolCall,ctx:AgentContext,db:SupabaseClient,run:LegacyRunner,durable?:DurableSteps):Promise<ToolResult>{
  const instructions=String(call.input.instructions??call.input.direction??call.input.targetLanguage??'راجع وأعد صياغة المحتوى بالمصري المهني') + (call.name==='improve_hook'?' — عدّل الافتتاحية فقط وحافظ على باقي النص':call.name==='generate_cta'?' — عدّل الدعوة للتفاعل فقط وحافظ على باقي النص':call.name==='generate_hashtags'?' — عدّل الهاشتاجات فقط وحافظ على باقي النص':'');
  const batchId=String(call.input.batchId??ctx.selectedCampaignId??'');
  const contentId=String(call.input.contentId??ctx.currentContentId??'');
  if(!batchId&&!contentId)throw new Error('حدد المنشور أو الحملة المطلوب تعديلها.');
  const load=async()=>{
    let query=db.from('content').select('id,title').eq('workspace_id',ctx.workspaceId);
    query=batchId?query.eq('batch_id',batchId):query.eq('id',contentId);
    const {data:posts,error}=await query.order('created_at');if(error)throw error;
    if(!posts?.length)throw new Error('المحتوى غير موجود في مساحة العمل.');
    let variants=db.from('content_variants').select('id,content_id,platform,text,hashtags,cta,status,updated_at,scheduled_at').eq('workspace_id',ctx.workspaceId).in('content_id',posts.map(p=>p.id)).order('created_at');
    const variantId=String(call.input.variantId??ctx.currentVariantId??'');
    if(variantId&&!call.input.onlyPlatform&&!exclusivePlatform(instructions))variants=variants.eq('id',variantId);
    const {data:rows,error:err}=await variants;if(err)throw err;
    if(!rows?.length)throw new Error('لا توجد نسخ قابلة للتعديل.');
    return {posts,rows:rows as Row[]};
  };
  const snapshot=durable?await durable.run(`revision-source:${call.id}`,load,false):await load();
  const only=String(call.input.onlyPlatform??(call.name==='adapt_for_platform'?call.input.platform:undefined)??exclusivePlatform(instructions)??'');
  if(only&&!['linkedin','facebook','instagram','x','telegram'].includes(only))throw new Error('منصة غير مدعومة.');
  const retained=only?snapshot.posts.flatMap(p=>{
    const rows=snapshot.rows.filter(r=>r.content_id===p.id);return rows.length?[rows.find(r=>r.platform===only)??rows[0]]:[];
  }):snapshot.rows;
  const dates=retained.map(r=>new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(r.scheduled_at??Date.now())));
  const slots=retained.map(r=>({title:snapshot.posts.find(p=>p.id===r.content_id)!.title,content:r.text,platform:only||r.platform,hashtags:r.hashtags,cta:r.cta}));
  const {result}=await run('create_content_plan',instructions,slots.map(s=>s.platform),{post_count:slots.length,existing_slots:slots,revision:true,schedule:{dates}});
  const generated=result.slots as Array<Record<string,unknown>>;
  const updates=generated.map((s,i)=>({...s,id:retained[i].id}));
  const removed=snapshot.rows.filter(r=>!retained.some(k=>k.id===r.id)).map(r=>r.id);
  const {data,error}=await db.rpc('apply_editorial_revision',{p_workspace_id:ctx.workspaceId,p_user_id:ctx.userId,p_operation_key:`${durable?.taskKey??crypto.randomUUID()}:${call.id}`,p_task_id:durable?.taskKey??null,p_worker_id:durable?.workerKey??null,p_snapshot:snapshot.rows,p_updates:updates,p_remove_ids:removed,p_feedback:instructions});
  if(error)throw error;
  return {callId:call.id,name:call.name,ok:true,output:{...data,revision:true,theme:'المحتوى بعد التعديل',slots:generated.map((s,i)=>({...s,date:retained[i].scheduled_at?dates[i]:''})),batchId:batchId||null,contentId:contentId||null,advice:`اتعدلت ${updates.length} نسخة واتراجعت، واتحذفت ${removed.length} نسخة من المسودة. التعديلات محفوظة للمراجعة قبل النشر.`}};
}
