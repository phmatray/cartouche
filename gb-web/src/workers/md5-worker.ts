// Hashes a ROM for RetroAchievements off the main thread (see components/game/Achievements.tsx).
import { md5 } from '../lib/retroachievements';

self.onmessage = (e: MessageEvent<Uint8Array>) => self.postMessage(md5(e.data));
