type PostText = { text: string; cta?: string | null; hashtags?: readonly string[] };

/** Publish the reviewed copy exactly; never silently cut its meaning or CTA. */
export function buildPostText(variant: PostText, maxLen?: number): string {
  const parts = [variant.text.trim()];
  if (variant.cta?.trim()) parts.push(variant.cta.trim());
  if (variant.hashtags?.length) parts.push(variant.hashtags.join(' '));
  const text = parts.filter(Boolean).join('\n\n');
  if (maxLen && text.length > maxLen) {
    throw new Error(`النص الكامل مع الدعوة للتفاعل والهاشتاجات أطول من الحد المسموح (${maxLen} حرف). اختصر نسخة هذه المنصة وأعد مراجعتها قبل النشر؛ لم يتم قص النص أو إرساله.`);
  }
  return text;
}
