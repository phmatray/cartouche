// node --test: rcheevos (the built src/vendor/rcheevos.js) against a fake RetroAchievements server: sign-in, game
// load, an achievement unlocking from memory, its award sent through the relay, and a save-state jump dropping hits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT, EV, play, RELAY, signIn, type RaEvent } from './ra-client.ts';

const calls: URLSearchParams[] = [];
const ach = (id: number, mem: string) => ({ ID: id, Title: `Ach ${id}`, Description: 'd', Flags: 3, Points: 5, MemAddr: mem, Author: 'a', BadgeName: '001', Created: 1, Modified: 1 });
const replies: Record<string, object> = {
  login2: { Success: true, User: 'Player', Token: 'TOKEN', Score: 0, SoftcoreScore: 0, Messages: 0, Permissions: 1, AccountType: 'Registered' },
  achievementsets: {
    Success: true, GameId: 77, Title: 'Homebrew', ConsoleId: 4, ImageIconUrl: 'http://x/i.png', RichPresenceGameId: 77, RichPresencePatch: '',
    Sets: [{ AchievementSetId: 1, GameId: 77, Title: null, Type: 'core', ImageIconUrl: 'http://x/i.png',
      Achievements: [ach(501, '0xH0010=5'), ach(502, '0xH0011=1.3.')], Leaderboards: [] }],
  },
  startsession: { Success: true, Unlocks: [], HardcoreUnlocks: [], ServerNow: 1700000000 },
  awardachievement: { Success: true, Score: 5, SoftcoreScore: 5, AchievementID: 501, AchievementsRemaining: 1 },
  ping: { Success: true },
};
globalThis.fetch = (async (url: string, init: RequestInit) => {
  assert.equal(url, RELAY);
  assert.equal((init.headers as Record<string, string>)['X-RA-Client'], CLIENT);
  const q = new URLSearchParams(String(init.body));
  calls.push(q);
  return new Response(JSON.stringify(replies[q.get('r')!] ?? { Success: false, Error: 'unexpected' }));
}) as typeof fetch;

const settle = () => new Promise((r) => setTimeout(r, 10));

test('signs in, loads the set and unlocks from memory, through the relay', async () => {
  assert.match(CLIENT, /^Cartouche\/\d+\.\d+\.\d+ \(Web\) gb-core\/\d+\.\d+\.\d+$/);
  const me = await signIn('player', 'pw');
  assert.deepEqual(me, { user: 'Player', token: 'TOKEN' });
  assert.equal(calls[0].get('p'), 'pw');

  const mem = new Uint8Array(0x10000);
  const events: RaEvent[] = [];
  const s = await play('0123456789abcdef0123456789abcdef', (a) => mem[a], (e) => events.push(e));
  assert.ok(s);
  assert.equal(s.gameId, 77);
  assert.deepEqual([s.earned, s.total], [0, 2]);
  assert.equal(calls.find((q) => q.get('r') === 'startsession')?.get('h'), '0', 'softcore');

  s.frame(); // achievements arm on a frame where they are false
  mem[0x10] = 5;
  s.frame();
  await settle();
  const got = events.filter((e) => e.type === EV.UNLOCKED);
  assert.deepEqual(got.map((e) => [e.id, e.title, e.points]), [[501, 'Ach 501', 5]]);
  const award = calls.find((q) => q.get('r') === 'awardachievement');
  assert.equal(award?.get('a'), '501');
  assert.equal(award?.get('h'), '0');

  // 502 needs 3 frames with $11=1: a state loaded after 2 starts the count again.
  mem[0x11] = 1;
  s.frame(); s.frame();
  s.jumped();
  mem[0x11] = 0; s.frame(); // a reset achievement arms again on a false frame
  mem[0x11] = 1; s.frame(); s.frame(); // 2 hits: without the reset, 2 + 1 would already have unlocked it
  assert.ok(!events.some((e) => e.id === 502), 'hits from before the jump are gone');
  s.frame();
  assert.ok(events.some((e) => e.id === 502 && e.type === EV.UNLOCKED));
  s.end();
});
