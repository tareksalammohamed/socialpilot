export function isEditorialFollowup(message:string):boolean {
  return /عد[ّل]|عدل|غي[ّر]|غير|خلي|خلّي|خلى|امسح|احذف|شيل|أعد صياغ|اعد صياغ|صياغه|راجع|دقق|rewrite|revise|remove|only/i.test(message) && !/حملة جديدة|حمله جديده|بوست جديد|منشور جديد/i.test(message);
}
export function exclusivePlatform(message:string):string|undefined {
  if(!/بس|فقط|only/i.test(message))return;
  const normalized=message.replace(/لينكد\s*[إا]?ن|لينكدإن|لينكدين/gi,'linkedin').replace(/انست[جقغ]رام|إنست[جقغ]رام/gi,'instagram').replace(/فيس\s*بوك/gi,'facebook');
  return normalized.match(/(linkedin|instagram|facebook|telegram|\bx\b)\s*(?:بس|فقط|only)/i)?.[1]?.toLowerCase()
    ?? normalized.match(/only\s+(linkedin|instagram|facebook|telegram|x)\b/i)?.[1]?.toLowerCase();
}
export function directEditorialPlan(message:string,context:{currentContentId?:string;selectedCampaignId?:string;currentVariantId?:string}) {
  if(!isEditorialFollowup(message)||(!context.currentContentId&&!context.selectedCampaignId))return null;
  return {intentLabel:'edit_content' as const,planSummary:'تعديل المحتوى الموجود ومراجعته وحفظ تصحيحك في ذاكرة البراند.',steps:[{label:'تعديل ومراجعة المحتوى الموجود',tool:'revise_existing_content' as const,input:{instructions:message,contentId:context.currentContentId,batchId:context.selectedCampaignId,variantId:context.currentVariantId,onlyPlatform:exclusivePlatform(message)}}]};
}
