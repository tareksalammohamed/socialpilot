import { parseIntent } from '../functions/_shared/content-intent.ts';
import { creationDefaults, directCreationPlan, isSimpleCreation, continueCreation, continueRecentCreation } from '../functions/_shared/creation-policy.ts';
function equal(actual:unknown,expected:unknown){if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error(`${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);}
const now=new Date('2026-10-04T12:31:00Z');
const req=(message:string)=>({message,context:{currentRoute:'create'},legacyContext:{} as Record<string,unknown>});
Deno.test('a week campaign starts without questions and yields seven future Cairo slots',()=>{
 const request=creationDefaults(req('اعمل حملة أسبوع'),['facebook','linkedin'],now);
 equal(request.legacyContext.post_count,7);
 equal(request.legacyContext.start_date,'2026-10-05');
 equal(request.legacyContext.end_date,'2026-10-11');
 equal(request.legacyContext.schedule,{dates:['2026-10-05','2026-10-06','2026-10-07','2026-10-08','2026-10-09','2026-10-10','2026-10-11'],time:'09:00'});
 equal(directCreationPlan(request)?.steps[0].tool,'create_content_plan');
 equal(directCreationPlan(request)?.steps[0].input.platforms,['facebook','linkedin']);
});
Deno.test('explicit count, date, platform and posting time override defaults',()=>{
 const request=creationDefaults(req('اعمل ٣ بوستات لمدة أسبوع على فيسبوك من 2026-10-10 الساعة ٨ مساء'),['linkedin'],now);
 equal(request.legacyContext.post_count,3);
 equal(request.legacyContext.start_date,'2026-10-10');
 equal((request.legacyContext.schedule as {time:string}).time,'20:00');
 equal(directCreationPlan(request)?.steps[0].input.platforms,['facebook']);
});
Deno.test('duration, bare campaign, single post and named weekday stay meaningful',()=>{
 equal(parseIntent('اعمل حملة لمدة 2 اسبوع',now).postCount,14);
 equal(parseIntent('اعمل حملة',now).postCount,7);
 equal(parseIntent('اكتب بوست',now).postCount,1);
 equal(parseIntent('اعمل حملة أسبوع من الخميس',now).startDate,'2026-10-08');
 equal(parseIntent('create content next week',now).platforms,[]);
});
Deno.test('defaults are frozen across durable retries and Cairo midnight',()=>{
 const first=creationDefaults(req('اشتغل حملة أسبوع'),['facebook'],new Date('2026-10-04T22:30:00Z'));
 equal(first.legacyContext.start_date,'2026-10-06');
 equal(creationDefaults(first,['linkedin'],new Date('2026-10-06T12:00:00Z')),first);
});
Deno.test('edits, unclear existing targets, publication, ideas and cancellations are not drafted by shortcut',()=>{
 for(const text of ['انشر البوست','اكتب حملة وانشرها','عدل البوست ده','كيف أعمل حملة','اقترح أفكار محتوى','مش عايز حملة'])equal(isSimpleCreation(req(text)),false);
 equal(isSimpleCreation({...req('اكتب بوست'),context:{currentContentId:'existing'}}),false);
 equal(directCreationPlan(req('اعمل حملة أسبوع')),null);
});

Deno.test('a scheduling reply continues the prior draft instead of repeating questions',()=>{
 const message=continueCreation('ابدا من بكره لمده اسبوع','لينكد ان واعمل كل يوم بوست الساعه ٩ صباحا عن التامين وعن إدارة فرق البيع');
 const request=creationDefaults(req(message),['facebook','linkedin'],now);
 equal(request.legacyContext.post_count,7);equal(request.legacyContext.start_date,'2026-10-05');
 equal(directCreationPlan(request)?.steps[0].input.platforms,['linkedin']);
 equal(continueCreation('احذف المنشور','اعمل حملة أسبوع'),'احذف المنشور');
});

Deno.test('scheduling replies never reuse an old clarification across a completed draft',()=>{
 const message='ابدا من بكره لمدة أسبوع';
 equal(continueRecentCreation(message,[{message:'اكتب بوست جديد',resultType:'content'},{message:'اعمل حملة قديمة',resultType:'clarification'}]),message);
 equal(continueRecentCreation(message,[{message:'الساعة تسعة',resultType:'clarification'},{message:'اعمل حملة أسبوع',resultType:'clarification'}]),continueCreation(message,'اعمل حملة أسبوع'));
});

Deno.test('the reported Egyptian today command starts today at a future local hour',()=>{
 for(const word of ['انهارده','النهارده','النهاردة','انهاردة']) {
  const request=creationDefaults(req(`انشئ حمله اسبوع يبدأ من ${word} عن التامين والادارة`),['facebook','instagram','linkedin'],now);
  equal(request.legacyContext.start_date,'2026-10-04');
  equal(request.legacyContext.end_date,'2026-10-10');
  equal((request.legacyContext.schedule as {time:string}).time,'16:00');
 }
});
