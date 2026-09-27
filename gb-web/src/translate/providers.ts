/**
 * Claude with the player's own Anthropic API key, called straight from the browser (Chrome's on-device
 * translator is in chrome.ts). Loaded with the reader, only once translate is on.
 */
import type { Lang } from './store';
import { t } from '../i18n/core.ts';

// ---- Claude (Anthropic Messages API, the player's own key)

export const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const LANG_NAME: Record<string, string> = { en: 'English', fr: 'French', es: 'Spanish', ja: 'Japanese' };

export interface ClaudeResult { translation: string; /** The original as Claude reads it, misread characters fixed. */ source?: string }

/**
 * One line, translated with the game's title and the lines before it (names and tone stay consistent).
 * The text comes from tile matching: Claude is told it may hold look-alike mistakes and □ for unread
 * characters, and returns the corrected original too (the reader learns from it).
 * ponytail: plain fetch, one request shape; the Anthropic SDK would add ~100 KB for nothing here.
 */
export async function claudeTranslate(o: { key: string; text: string; src: 'ja' | 'en'; dst: Lang; title: string; previous: string[]; signal?: AbortSignal }): Promise<ClaudeResult> {
  const system =
    `You translate the on-screen text of a ${LANG_NAME[o.src]} Game Boy game into ${LANG_NAME[o.dst]}. ` +
    'The text was read from the screen by matching 8x8 tiles against a font, so a few characters may be wrong ' +
    '(look-alike kana such as の/め, は/け, ま/え, さ/せ) and □ marks a character that could not be read: ' +
    'infer the intended words from context. Keep the translation short and natural, like game dialogue, ' +
    'and keep names consistent with the previous lines. Reply with JSON only: ' +
    '{"source": "<the original text, corrected>", "translation": "<the translation>"}';
  const prev = o.previous.length ? `Previous lines:\n${o.previous.map((l) => `- ${l}`).join('\n')}\n\n` : '';
  let res: Response;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: o.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': o.key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL, max_tokens: 600, system,
        messages: [{ role: 'user', content: `Game: ${o.title}\n\n${prev}Text:\n${o.text}` }],
      }),
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw new ClaudeError(t('translate.err.offline'), 0); // the browser's own words ("Failed to fetch", "Load failed") say nothing
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new ClaudeError(errorText(res.status, body?.error?.message), res.status);
  }
  const data = await res.json() as { content?: { type: string; text?: string }[]; stop_reason?: string };
  if (data.stop_reason === 'refusal') throw new ClaudeError(t('translate.err.declined'), 200);
  const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return parseResult(text);
}

/** A failed request, with its HTTP status (0: no answer at all). */
export class ClaudeError extends Error {
  readonly status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

/**
 * What to tell the player about an HTTP error: a refused key (401), a rate limit (429), an empty balance
 * (Anthropic answers 400 "credit balance is too low"), else the API's own message.
 */
export function errorText(status: number, message?: string): string {
  if (status === 401) return t('translate.err.refused');
  if (status === 429) return t('translate.err.busy');
  if (status === 400 && /credit/i.test(message ?? '')) return t('translate.err.credit');
  return message || t('translate.err.status', { status: String(status) });
}

/** The JSON reply, tolerating a code fence or prose around it; plain text becomes the translation. */
export function parseResult(text: string): ClaudeResult {
  const m = /\{[\s\S]*\}/.exec(text);
  if (m) {
    try {
      const j = JSON.parse(m[0]) as Partial<ClaudeResult>;
      if (typeof j.translation === 'string') return { translation: j.translation.trim(), source: typeof j.source === 'string' ? j.source.trim() : undefined };
    } catch { /* not JSON after all */ }
  }
  return { translation: text };
}
