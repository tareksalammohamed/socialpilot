export type ModelFailure = { provider: string; model: string; error: string };

function failureReasons(errors: string[]): string {
  const reasons = new Set<string>();
  for (const error of errors) {
    if (/429|rate[ -]?limit/i.test(error)) reasons.add('حد الاستخدام مؤقتًا (429)');
    if (/Structured output validation|truncated|JSON parse/i.test(error)) reasons.add('رد وصل لكنه لم يجتز فحص الصيغة أو الجودة');
    if (/timeout|timed out|aborted/i.test(error)) reasons.add('انتهاء مهلة الرد');
    if (/API key not configured/i.test(error)) reasons.add('مفتاح مزود غير مضبوط');
  }
  return [...reasons].join('؛ ') || 'تعذر الحصول على رد صالح لهذه الخطوة';
}

export function modelFailureMessage(attempts: ModelFailure[], deadlineReached = false): string {
  const providers = [...new Set(attempts.map(a => a.provider))];
  const models = new Set(attempts.map(a => `${a.provider}/${a.model}`));
  const prefix = deadlineReached ? 'انتهت مهلة المحاولة دون رد صالح.' : 'لم تنجح المحاولات لهذه الخطوة.';
  return `${prefix} ${attempts.length} محاولات، ${models.size} نماذج، ${providers.length} مزود (${providers.join('، ')}). الأسباب: ${failureReasons(attempts.map(a => a.error))}.`;
}

/** Old persisted errors contain raw upstream JSON and call models providers. */
export function taskErrorMessage(error: string): string {
  if (!error.startsWith('فشلت كل محاولات الـAI Providers')) return error;
  const count = error.match(/المتاحة \((\d+)\)/)?.[1];
  return `لم تنجح ${count ? `${count} محاولات` : 'المحاولات'} لهذه الخطوة. الأسباب: ${failureReasons([error])}.`;
}
