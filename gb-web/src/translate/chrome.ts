/**
 * Chrome's built-in Translator API (on-device, free, desktop Chrome 138+ only). Small and separate from the
 * Claude code (providers.ts): the player page needs this much to turn translate on from a click.
 */
import type { ChromeStatus, Lang } from './store';
import { t as tr } from '../i18n/core.ts';

// https://developer.chrome.com/docs/ai/translator-api
interface ChromeTranslator { translate(text: string): Promise<string> }
interface TranslatorStatic {
  availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<'unavailable' | 'downloadable' | 'downloading' | 'available'>;
  create(o: { sourceLanguage: string; targetLanguage: string; monitor?: (m: EventTarget) => void }): Promise<ChromeTranslator>;
}
const api = () => (globalThis as unknown as { Translator?: TranslatorStatic }).Translator;
/** Chrome's Translator API is here (desktop Chrome 138+; never on iPhone or iPad). */
export const hasChromeTranslator = () => !!api();

export async function chromeStatus(src: string, dst: Lang): Promise<ChromeStatus> {
  const T = api();
  if (!T) return 'missing';
  try { return await T.availability({ sourceLanguage: src, targetLanguage: dst }); } catch { return 'unavailable'; }
}

const translators = new Map<string, Promise<ChromeTranslator>>();
/**
 * The translator for a language pair, created once. A model that still has to be downloaded needs a user
 * gesture to start: call this from a click first (the toggle does), later calls reuse it.
 */
export function chromeTranslator(src: string, dst: Lang, onProgress?: (loaded: number) => void): Promise<ChromeTranslator> {
  const T = api();
  if (!T) return Promise.reject(new Error(tr('translate.err.noTranslator')));
  const k = `${src}>${dst}`;
  let t = translators.get(k);
  if (!t) {
    t = T.create({
      sourceLanguage: src, targetLanguage: dst,
      monitor: (m) => m.addEventListener('downloadprogress', (e) => onProgress?.((e as ProgressEvent).loaded)),
    });
    t.catch(() => translators.delete(k));
    translators.set(k, t);
  }
  return t;
}
