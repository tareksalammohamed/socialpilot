import { useCallback, useRef, useState } from 'react';

type Draft = { text: string; saved: boolean };
const PREFIX = 'socialpilot:draft:v1:';

export function draftKey(userId: string | undefined, workspaceId: string | undefined, field: string): string | null {
  return userId && workspaceId ? PREFIX + [userId, workspaceId, field].map(encodeURIComponent).join(':') : null;
}

function read(key: string | null): Draft {
  if (!key) return { text: '', saved: false };
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { text: '', saved: true };
    const data: unknown = JSON.parse(raw);
    if (data && typeof data === 'object' && 'version' in data && data.version === 1 && 'text' in data && typeof data.text === 'string' && data.text.length <= 200_000) {
      return { text: data.text, saved: true };
    }
    return { text: '', saved: true };
  } catch { return { text: '', saved: false }; }
}

function write(key: string | null, text: string): boolean {
  if (!key || text.length > 200_000) return false;
  try {
    if (text) localStorage.setItem(key, JSON.stringify({ version: 1, text }));
    else localStorage.removeItem(key);
    return true;
  } catch { return false; }
}

/** Device-local drafts, isolated by user, workspace and editor. A late send
 * completion can clear only the exact text it sent, never a newer edit. */
export function useDraft(key: string | null) {
  const cache = useRef(new Map<string | null, Draft>());
  const [, render] = useState(0);
  const current = () => {
    if (!cache.current.has(key)) cache.current.set(key, read(key));
    return cache.current.get(key)!;
  };
  const draft = current();

  const setDraft = useCallback((text: string) => {
    cache.current.set(key, { text, saved: write(key, text) });
    render(value => value + 1);
  }, [key]);

  const replaceIfUnchanged = useCallback((expected: string, next: string) => {
    const value = cache.current.get(key) ?? read(key);
    if (value.text !== expected) return;
    // Another tab may have saved a newer draft even while this editor was idle.
    const stored = read(key);
    const canPersist = !stored.saved || stored.text === expected;
    cache.current.set(key, { text: next, saved: canPersist && write(key, next) });
    render(value => value + 1);
  }, [key]);

  return { text: draft.text, saved: draft.saved, setDraft, replaceIfUnchanged };
}
