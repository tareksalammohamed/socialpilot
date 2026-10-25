import { platformSelection } from './content-intent.ts';

function normalized(message: string): string {
  return message.normalize('NFKC').replace(/[\u064B-\u065F\u0670\u0640]/gu, '').replace(/[أإآ]/gu, 'ا').trim();
}

/** A direct edit must never swallow a separate publication/deletion instruction. */
export function isEditorialFollowup(message: string): boolean {
  const text = normalized(message);
  if (/(?:^|\s|[،؛])و?(?:انشر|انشره|انشرها|انشرهم|جدول|جدوله|جدولها|الغي|الغ|اوقف|وقف)(?:\s|$)|\b(?:publish|schedule|cancel|connect|disconnect)\b/iu.test(text)) return false;
  if (/(?:احذف|امسح|شيل)\s+(?:الطلب|الحملة|الحمله|البوست|المنشور|المحتوى)(?:\s|$)|\b(?:delete|remove)\s+(?:the\s+)?(?:post|campaign|request)\b/iu.test(text)) return false;
  if (/(?:اكتب|اعمل|انشئ|الف)\s*(?:لي\s*|ليا\s*)?(?:بوست|منشور|حملة|حمله|محتوى)|\b(?:write|create|draft)\s+(?:a\s+)?(?:post|campaign)\b/iu.test(text)) return false;
  if (/حملة جديدة|حمله جديده|بوست جديد|منشور جديد|new\s+(?:post|campaign)/iu.test(text)) return false;
  if (/(?:^|\s)(?:عدل|غير|خلي|خلى|خليها|خليه|امسح|احذف|شيل|اعد صياغ[ةه]?|صياغ[ةه]|راجع|دقق|اختصر|اختصره|اختصرها|قصره|قصرها|طوله|طولها|بس[طّ]|بسطه|بسطها|rewrite|revise|remove|shorten|expand|simplify|only)(?:\s|$)/iu.test(text)) return true;
  // A terse correction still has an unambiguous existing-content meaning.
  return /^(?:بالمصري|بالعامية|بالعاميه|بالفصحى|بالانجليزي|بالانجليزية|بالانجليزيه)(?:\s|$)/u.test(text)
    || revisionPlatforms(message).included.length > 0 || revisionPlatforms(message).excluded.length > 0;
}

/** Multiple retained platforms are a set, not whichever alias matched first. */
export function revisionPlatforms(message: string): { included: string[]; excluded: string[] } {
  const { platforms, excludedPlatforms } = platformSelection(message);
  const exclusive = /(?:^|\s)(?:بس|فقط|only)(?:\s|[،,.!?؟]|$)/iu.test(message)
    && !/(?:مش|موش|ليس|not)\s+(?:بس|فقط|only)/iu.test(message);
  return { included: exclusive ? platforms : [], excluded: excludedPlatforms };
}

export function exclusivePlatform(message: string): string | undefined {
  const included = revisionPlatforms(message).included;
  return included.length === 1 ? included[0] : undefined;
}

type EditorialSource = {
  status: string; archived_at?: string | null; content_id?: string | null; batch_id?: string | null;
  result?: Record<string, unknown> | null;
};
/** Do not jump past deleted/failed/unresolved requests to edit unrelated older work. */
export function editorialTarget(source: EditorialSource | null | undefined): { currentContentId?: string; selectedCampaignId?: string } {
  if (!source || source.archived_at || source.status !== 'completed') return {};
  const revision = source.result?.revision === true ? source.result : {};
  const contentId = source.content_id ?? revision.contentId;
  const batchId = source.batch_id ?? revision.batchId;
  // A campaign takes precedence over an incidental content ID from its last slot.
  if (typeof batchId === 'string' && batchId) return { selectedCampaignId: batchId };
  return typeof contentId === 'string' && contentId ? { currentContentId: contentId } : {};
}

export function directEditorialPlan(message: string, context: { currentContentId?: string; selectedCampaignId?: string; currentVariantId?: string }) {
  if (!isEditorialFollowup(message) || (!context.currentContentId && !context.selectedCampaignId)) return null;
  return { intentLabel: 'edit_content' as const, planSummary: 'تعديل المحتوى الموجود ومراجعته وحفظ تصحيحك في ذاكرة البراند.', steps: [{ label: 'تعديل ومراجعة المحتوى الموجود', tool: 'revise_existing_content' as const, input: { instructions: message, contentId: context.currentContentId, batchId: context.selectedCampaignId, variantId: context.currentVariantId, onlyPlatform: exclusivePlatform(message) } }] };
}
