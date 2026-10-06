import { modelFailureMessage, taskErrorMessage } from '../functions/_shared/model-failure.ts';
function assert(value: unknown) { if (!value) throw new Error('assertion failed'); }
Deno.test('model attempts do not claim multiple providers or absent responses', () => {
  const message = modelFailureMessage([
    { provider: 'openrouter', model: 'a', error: 'Structured output validation failed' },
    { provider: 'openrouter', model: 'b', error: '{"code":429,"raw":"private debug"}' },
  ]);
  assert(message.includes('2 نماذج، 1 مزود (openrouter)'));
  assert(message.includes('رد وصل') && message.includes('429'));
  assert(!message.includes('private debug'));
});
Deno.test('deadline errors describe bounded attempts and distinct providers', () => {
  const message = modelFailureMessage([
    { provider: 'openrouter', model: 'a', error: 'timeout' },
    { provider: 'groq', model: 'a', error: 'timeout' },
  ], true);
  assert(message.includes('انتهت مهلة') && message.includes('2 مزود'));
});
Deno.test('persisted legacy errors are readable without exposing upstream JSON', () => {
  const message = taskErrorMessage('فشلت كل محاولات الـAI Providers المتاحة (4). Structured output validation failed | {"code":429,"raw":"debug"}');
  assert(message.includes('4 محاولات') && message.includes('رد وصل') && message.includes('429'));
  assert(!message.includes('debug'));
  assert(taskErrorMessage('مشكلة أخرى') === 'مشكلة أخرى');
});
