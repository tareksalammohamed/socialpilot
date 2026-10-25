import { editorialRules,enforceEditorialReview,enforceEditorialChecklist,EDITORIAL_CHECKS,cleanGeneratedText } from '../functions/_shared/editorial-policy.ts';
import { directEditorialPlan,exclusivePlatform,isEditorialFollowup,revisionPlatforms,editorialTarget } from '../functions/_shared/editorial-followup.ts';
const pass={verdict:'pass',scores:{overall:100},reasons:[],suggested_improvements:[]};
Deno.test('default medium posts reject article length while explicit word counts override it',()=>{
 const content='العميل محتاج يفهم الفكرة عشان يقدر يختار بهدوء. '.repeat(24);
 const post={title:'فكرة واضحة',content};
 if(!editorialRules('اكتب بوست','').includes('80 إلى 140'))throw Error('medium default missing');
 if(enforceEditorialReview(pass,post,'اكتب بوست',editorialRules('اكتب بوست','')).verdict==='pass')throw Error('article length passed');
 if(enforceEditorialReview(pass,post,'اكتب بوست في 300 كلمة',editorialRules('اكتب بوست في 300 كلمة','')).verdict!=='pass')throw Error('explicit length ignored');
 if(enforceEditorialReview(pass,post,'اكتب بوست مش طويل',editorialRules('اكتب بوست مش طويل','')).verdict==='pass')throw Error('negative request treated as long override');
 if(editorialRules('اكتب بوست قصير','').includes('80 إلى 140'))throw Error('explicit short request ignored');
});
Deno.test('fabricated experiences and percentages override optimistic model scores',()=>{
 const post={title:'قصة حقيقية',content:'كنت أعمل مع فريق مبيعات وارتفع معدل إغلاقه بنسبة 40%.'};
 const q=enforceEditorialReview(pass,post,'اكتب بوست عن المبيعات',editorialRules('اكتب',''));
 if(q.verdict==='pass'||Number((q.scores as Record<string,number>).overall)>60)throw Error('fabrication approved');
 const supported=enforceEditorialReview(pass,post,post.title+' '+post.content,'');if(supported.verdict!=='pass')throw Error('user evidence ignored');
});
Deno.test('Egyptian preference is explicit and user language overrides defaults',()=>{
 if(!editorialRules('اكتب بوست','').includes('اكتب باللهجة المصرية'))throw Error('Egyptian default missing');
 if(editorialRules('اكتب بالفصحى','').includes('اكتب باللهجة المصرية'))throw Error('explicit language ignored');
 if(editorialRules('اكتب بالإنجليزية','').includes('اكتب باللهجة المصرية'))throw Error('formal English alias ignored');
 if(!editorialRules('اكتب بالمصري مش بالإنجليزي','').includes('اكتب باللهجة المصرية'))throw Error('negated English selected');
 if(cleanGeneratedText('أول سطر\\nتاني سطر')!=='أول سطر\nتاني سطر')throw Error('escaped newline leaked');
});
Deno.test('existing campaign platform corrections execute directly without drafting or questions',()=>{
 const text='خليها لينكد ان بس وامسح نسخه انستقرام';
 if(exclusivePlatform(text)!=='linkedin')throw Error('Egyptian platform spelling missed');
 const plan=directEditorialPlan(text,{selectedCampaignId:'existing'});
 if(plan?.steps[0].tool!=='revise_existing_content'||plan.steps[0].input.onlyPlatform!=='linkedin'||plan.steps[0].input.batchId!=='existing')throw Error('existing campaign not targeted');
 if(directEditorialPlan('اعمل حملة جديدة', {selectedCampaignId:'existing'}))throw Error('new campaign treated as edit');
});

Deno.test('unrequested Hebrew and Greek scripts cannot pass an Egyptian editorial review',()=>{
 for(const word of ['ולמה','γιατί']) {
  const q=enforceEditorialReview(pass,{title:'إدارة الفريق',content:`الفريق محتاج يفهم الهدف ${word} عشان يعرف المطلوب منه بوضوح.`},'اكتب بالمصري',editorialRules('اكتب بالمصري',''));
  if(q.verdict==='pass')throw Error('foreign script accepted');
 }
});

Deno.test('sales stories preserve supplied true stories and clearly hypothetical narratives',()=>{
 const rules=editorialRules('اكتب Sales Story بالمصري','');
 if(!rules.includes('حافظ على السرد')||!rules.includes('قصة حقيقية بالتفاصيل'))throw Error('storytelling disabled');
 const fictional={title:'اسمع قبل ما تعرض',content:'تخيل عميل محتار بين اختيارين، عشان تقدر تساعده اسأله إيه اللي محتاجه الأول. مثال افتراضي: ميزانيته 1000 جنيه مش رقم حقيقي لعميل.'};
 if(enforceEditorialReview(pass,fictional,'اكتب قصة بيعية بالمصري',rules).verdict!=='pass')throw Error('fictional sales story blocked');
 const trueStory={title:'اسأل الأول',content:'حصلت معايا مرة إن العميل كان محتاج يفهم الشروط، عشان كده شرحتله الاستثناءات قبل ما ياخد قراره.'};
 if(enforceEditorialReview(pass,trueStory,trueStory.content,rules).verdict!=='pass')throw Error('supplied story blocked');
 if(enforceEditorialReview(pass,trueStory,'اكتب قصة بيعية',rules).verdict==='pass')throw Error('fabrication attributed to user');
 const mixed={...fictional,content:fictional.content+' حققنا زيادة 40% في المبيعات.'};
 if(enforceEditorialReview(pass,mixed,'اكتب قصة بيعية',rules).verdict==='pass')throw Error('fictional label laundered real claim');
});
Deno.test('every editorial check is required even for a perfect overall score',()=>{
 const checks=Object.fromEntries(EDITORIAL_CHECKS.map(key=>[key,true]));
 if(enforceEditorialChecklist({...pass,checks}).verdict!=='pass')throw Error('complete audit rejected');
 for(const key of EDITORIAL_CHECKS){
  for(const bad of [false,undefined,'true']){
   const q=enforceEditorialChecklist({...pass,checks:{...checks,[key]:bad}});
   if(q.verdict==='pass')throw Error('missing or failed audit accepted '+key);
  }
 }
 if(enforceEditorialChecklist(pass).verdict==='pass')throw Error('legacy review accepted without checks');
});
Deno.test('hashtags and calls to action are included in the deterministic language gate',()=>{
 const q=enforceEditorialReview(pass,{title:'اختيار التأمين',content:'اسأل العميل إيه اللي محتاجه عشان تقدر تساعده يفهم الشروط.',hashtags:['#ולמה']},'اكتب بالمصري',editorialRules('اكتب',''));
 if(q.verdict==='pass')throw Error('unsafe hashtag accepted');
});

Deno.test('new sales stories saved for review do not target an old campaign',()=>{
 for(const message of ['اكتب بوست واحد بصيغة Sales Story افتراضية، احفظه مسودة للمراجعة فقط ولا تنشره','اكتب بوست جديد فيه أرقام غير مختلقة']){
  if(isEditorialFollowup(message)||directEditorialPlan(message,{selectedCampaignId:'old'}))throw Error('new post targeted old campaign');
 }
 if(!isEditorialFollowup('راجع الحملة دي تاني بالمصري'))throw Error('real revision missed');
});

Deno.test('hypothetical stories cannot launder unsupported insurance coverage',()=>{
 const rules=editorialRules('اكتب بالمصري','');
 const unsafe={title:'تخيل الموقف',content:'تخيل عميل محتار، عشان كده المستشار بيشرح إزاي البوليصة دي بتغطي القلق ده تحديدًا.'};
 if(enforceEditorialReview(pass,unsafe,'اكتب قصة افتراضية بدون وعود تغطية',rules).verdict==='pass')throw Error('unsupported coverage passed');
 const safe={...unsafe,content:'تخيل عميل محتار، عشان كده المستشار بيراجع معاه الشروط والاستثناءات عشان يفهم إيه المناسب ليه.'};
 if(enforceEditorialReview(pass,safe,'اكتب قصة افتراضية',rules).verdict!=='pass')throw Error('safe story rejected');
 const checks=Object.fromEntries(EDITORIAL_CHECKS.map(key=>[key,true]));
 if(enforceEditorialChecklist({...pass,checks,scores:{overall:79}}).verdict==='pass')throw Error('weak review passed');
});

Deno.test('Egyptian edits resolve directly while new requests and public actions keep their planner',()=>{
 for(const message of ['اختصره','اختصرها وخليها بالمصري','طوله شوية','خليها بالمصري','خلّيه رسمي','غيّر الأسلوب','أعد صياغة المقدمة','بالمصري وبأسلوب أبسط','لينكدإن فقط','من غير انستجرام','فيسبوك ولينكد ان بس','shorten it','expand this']) {
  if(!isEditorialFollowup(message)||!directEditorialPlan(message,{currentContentId:'selected'}))throw Error('edit not understood: '+message);
 }
 for(const message of ['اكتب بوست جديد','اعمل حملة جديدة','احذف المنشور','امسح الطلب','الغي الجدولة','عدل البوست وانشره','اختصره وانشر','راجع البوست وجدوله','rewrite and publish it','كيف أكتب منشور؟']) {
  if(directEditorialPlan(message,{currentContentId:'selected'}))throw Error('action swallowed: '+message);
 }
 if(directEditorialPlan('اختصره',{}))throw Error('target invented');
 for(const message of ['اختصره','اختصرها شوية','طوله شوية','shorten it'])if(editorialRules(message,'').includes('80 إلى 140'))throw Error('explicit length overridden: '+message);
});
Deno.test('platform sets retain multiple choices and respect exclusions',()=>{
 const cases=[['خليها فيسبوك ولينكد ان بس',{included:['facebook','linkedin'],excluded:[]}],['شيل انستجرام وفيسبوك',{included:[],excluded:['instagram','facebook']}],['خليها لينكدإن فقط وشيل انستجرام',{included:['linkedin'],excluded:['instagram']}],['خليها فيسبوك بس مش انستجرام',{included:['facebook'],excluded:['instagram']}],['مش بس لينكدإن',{included:[],excluded:[]}]];
 for(const [message,expected] of cases)if(JSON.stringify(revisionPlatforms(String(message)))!==JSON.stringify(expected))throw Error('incorrect scope: '+message);
 if(exclusivePlatform('فيسبوك ولينكد ان بس'))throw Error('multiple platforms narrowed to one');
});
Deno.test('target follows saved results and stops at deleted or unresolved work',()=>{
 const source={status:'completed',content_id:'post',batch_id:'campaign'};
 if(JSON.stringify(editorialTarget(source))!==JSON.stringify({selectedCampaignId:'campaign'}))throw Error('campaign scope lost');
 if(Object.keys(editorialTarget({...source,archived_at:'2026-10-25'})).length)throw Error('deleted request reused');
 for(const status of ['running','queued','failed','cancelled'])if(Object.keys(editorialTarget({...source,status})).length)throw Error('unresolved request reused');
 if(editorialTarget({status:'completed',result:{revision:true,contentId:'edited-post',batchId:null}}).currentContentId!=='edited-post')throw Error('second revision lost target');
 if(Object.keys(editorialTarget({status:'completed',result:{contentId:'invented'}})).length)throw Error('advice trusted as target');
});
