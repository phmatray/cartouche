/** Room codes: six characters people can read aloud and type on a phone (no 0/O, 1/I/L, 5/S, 2/Z). */
const ALPHABET = '346789ABCDEFGHJKMNPQRTUVWXY';
export const CODE_LENGTH = 6;

export function makeCode(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  // 27^6 ≈ 387 million codes. Rejection sampling keeps every character equally likely.
  let out = '';
  while (out.length < CODE_LENGTH) {
    for (const b of random(CODE_LENGTH)) if (b < 243 && out.length < CODE_LENGTH) out += ALPHABET[b % 27];
  }
  return out;
}

/** What the player typed or pasted (a code, with dashes or spaces, or a whole invite link) as a code, or null. */
export function parseCode(input: string): string | null {
  const fromLink = /[?&]room=([^&#\s]+)/i.exec(input)?.[1];
  const s = (fromLink ?? input).toUpperCase().replace(/[\s\-–·.]/g, '');
  return s.length === CODE_LENGTH && [...s].every((c) => ALPHABET.includes(c)) ? s : null;
}

/** "K7MQ3P" as "K7M·Q3P", the way it's shown and read. */
export const spaced = (code: string) => `${code.slice(0, 3)}·${code.slice(3)}`;

/** The invite link: the app's own online lobby with the room in the query. */
export const inviteUrl = (code: string, base: string) => new URL(`link-cable/online?room=${code}`, base).href;
