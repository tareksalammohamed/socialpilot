import { parseIntent } from './content-intent.ts';

type DraftRequest = {
  message: string; platforms?: string[];
  context: { currentRoute?: string; currentContentId?: string; currentVariantId?: string; selectedPlatform?: string; selectedCampaignId?: string; selectedMediaId?: string };
  legacyContext?: Record<string, unknown>;
};

// Only new drafts can use this shortcut. Existing-item edits, questions,
// publishing and account actions continue through the normal planner.
export function isSimpleCreation(req: DraftRequest): boolean {
  const ctx=req.context;
  if(ctx.currentContentId||ctx.currentVariantId||ctx.selectedCampaignId||ctx.selectedMediaId)return false;
  if(/انشر|نشرها|تنشر|publish|احذف|حذف|delete|اربط|افصل|connect|cancel|الغ|ألغي|جدول المنشور|schedule the|عدّل|عدل|rewrite|أعد صياغة|مش عايز|مش عاوز|متعملش|لا تنشئ|don't|do not/i.test(req.message))return false;
  if(/ازاي|إزاي|كيف|how to|what is|ما هي|يعني ايه/i.test(req.message))return false;
  return (req.context.currentRoute==='create' || /اشتغل|جهز|جهّز|نفذ|اكتب|أكتب|اعمل|أعمل|أنشئ|انشئ|إنشاء|انشاء|ألّف|الف|تأليف|create|write|draft|build/i.test(req.message))
    && /بوست|منشور|محتوى|حملة|حمله|خطة|خطة|post|content|campaign|plan/i.test(req.message)
    && !/أفكار|افكار|ideas|اقترح|suggest/i.test(req.message);
}

export function creationDefaults<T extends DraftRequest>(req:T, connectedPlatforms:string[]=[],now=new Date()):T {
  if(!isSimpleCreation(req))return req;
  const previous=req.legacyContext??{};
  // Freeze dates and choices for durable retries, even after midnight.
  if(previous.creation_defaults_applied===true)return req;
  const timezone=typeof previous.timezone==='string'?previous.timezone:'Africa/Cairo';
  const parsed=parseIntent(req.message,now,timezone);
  if(!['create_content','create_content_plan'].includes(parsed.intent))return req;
  const platforms=parsed.platforms.length?parsed.platforms:req.platforms?.length?req.platforms:req.context.selectedPlatform?[req.context.selectedPlatform]:connectedPlatforms.length?connectedPlatforms:['facebook'];
  const summary=parsed.intent==='create_content_plan'
    ? `${parsed.postCount} منشورات من ${parsed.startDate} إلى ${parsed.endDate}، الساعة ${parsed.schedule.time} (${timezone})، على ${platforms.join('، ')}. المواعيد قابلة للتعديل.`
    : `مسودة على ${platforms.join('، ')} باستخدام سياق البراند المتاح.`;
  return {...req,platforms,legacyContext:{...previous,post_count:parsed.postCount,start_date:parsed.startDate,end_date:parsed.endDate,frequency:parsed.frequency,schedule:parsed.schedule,content_goal:parsed.contentGoal??previous.content_goal,content_type:parsed.contentType??previous.content_type,platforms,timezone,creation_intent:parsed.intent,creation_assumptions:summary,creation_defaults_applied:true}};
}

export function directCreationPlan(req:DraftRequest){
  if(!isSimpleCreation(req)||req.legacyContext?.creation_defaults_applied!==true)return null;
  const intent=req.legacyContext.creation_intent;
  if(intent!=='create_content'&&intent!=='create_content_plan')return null;
  return {intentLabel:intent,planSummary:String(req.legacyContext.creation_assumptions),steps:[{label:intent==='create_content_plan'?'تأليف الحملة ومراجعة جودتها':'تأليف المنشور ومراجعة جودته',tool:intent,input:{message:req.message,platforms:req.platforms??[]}}]};
}

export function isSchedulingFollowup(message:string):boolean {
  return /^(?:ابدأ|ابدا|ابدء|بداية|بدايه|من |الساعة|الساعه|لمدة|لمده|بكرة|بكره|غدا|start|from |at )/i.test(message.trim())
    && /بكره|بكرة|غد|اليوم|يوم|اسبوع|أسبوع|شهر|ساعة|الساعه|الساعة|\d{4}-\d{2}-\d{2}|tomorrow|today|week|month|at /i.test(message)
    && !/انشر|publish|احذف|delete|الغ|ألغي|cancel|عدل|عدّل/i.test(message);
}
export function continueCreation(message:string,previousMessage:string):string {
  if(!isSchedulingFollowup(message)||!isSimpleCreation({message:previousMessage,context:{currentRoute:'create'}}))return message;
  return `${message}\nالمطلوب الأصلي: ${previousMessage}`;
}

export function continueRecentCreation(message:string,previous:{message:string;resultType:string|null}[]):string {
  for(const item of previous){
    if(item.resultType!=='clarification')break;
    const combined=continueCreation(message,item.message);
    if(combined!==message)return combined;
  }
  return message;
}
