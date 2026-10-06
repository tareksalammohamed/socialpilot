import { editorialRules,enforceEditorialReview,enforceEditorialChecklist,EDITORIAL_CHECKS,cleanGeneratedText } from '../functions/_shared/editorial-policy.ts';
import { directEditorialPlan,exclusivePlatform,isEditorialFollowup } from '../functions/_shared/editorial-followup.ts';
const pass={verdict:'pass',scores:{overall:100},reasons:[],suggested_improvements:[]};
Deno.test('fabricated experiences and percentages override optimistic model scores',()=>{
 const post={title:'قصة حقيقية',content:'كنت أعمل مع فريق مبيعات وارتفع معدل إغلاقه بنسبة 40%.'};
 const q=enforceEditorialReview(pass,post,'اكتب بوست عن المبيعات',editorialRules('اكتب',''));
 if(q.verdict==='pass'||Number((q.scores as Record<string,number>).overall)>60)throw Error('fabrication approved');
 const supported=enforceEditorialReview(pass,post,post.title+' '+post.content,'');if(supported.verdict!=='pass')throw Error('user evidence ignored');
});
Deno.test('Egyptian preference is explicit and user language overrides defaults',()=>{
 if(!editorialRules('اكتب بوست','').includes('اكتب باللهجة المصرية'))throw Error('Egyptian default missing');
 if(editorialRules('اكتب بالفصحى','').includes('اكتب باللهجة المصرية'))throw Error('explicit language ignored');
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
