// Parse a complete document only: never salvage an inner object from truncated JSON.
export function parseStructured(content: string): unknown {
  const text = content.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/i, '$1');
  return JSON.parse(text);
}
export function validJson(content: string): boolean {
  try { parseStructured(content); return true; } catch { return false; }
}
export function validItems(content: string, key: string, count: number, quality = false, arabicOnly = false): boolean {
  try {
    const obj = parseStructured(content) as Record<string, unknown>;
    const items = obj?.[key];
    return Array.isArray(items) && items.length === count && items.every(item => {
      if (!item || typeof item !== 'object') return false;
      if (quality && arabicOnly) {
        const text = [...(Array.isArray(item.reasons) ? item.reasons : []), ...(Array.isArray(item.suggested_improvements) ? item.suggested_improvements : [])].join(' ');
        if (/[\p{Script=Han}\p{Script=Cyrillic}\p{Script=Hangul}\p{Script=Devanagari}]/u.test(text) || (text && !/[\p{Script=Arabic}]/u.test(text))) return false;
      }
      if (quality) return ['pass', 'review', 'fail'].includes(item.verdict)
        && item.scores && typeof item.scores === 'object' && !Array.isArray(item.scores)
        && Object.keys(item.scores).length > 0
        && Object.values(item.scores).every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100)
        && typeof item.scores.overall === 'number'
        && (item.verdict !== 'pass' || item.scores.overall >= 70)
        && Array.isArray(item.reasons) && item.reasons.every((v: unknown) => typeof v === 'string')
        && Array.isArray(item.suggested_improvements);
      if (arabicOnly) {
        const text = [item.title, item.content, item.goal, item.cta, ...(Array.isArray(item.hashtags) ? item.hashtags : [])].join(' ');
        if (/[\p{Script=Han}\p{Script=Cyrillic}\p{Script=Hangul}\p{Script=Devanagari}]/u.test(text) || !/[\p{Script=Arabic}]/u.test(String(item.content))) return false;
      }
      return typeof item.title === 'string' && item.title.trim().length > 0
        && typeof item.content === 'string' && item.content.trim().length >= 30
        && item.content.trim() !== item.title.trim();
    });
  } catch { return false; }
}
export function stableStringify(value: unknown): string {
  function canonical(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(canonical);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, canonical(x)]));
    return v;
  }
  return JSON.stringify(canonical(value));
}
