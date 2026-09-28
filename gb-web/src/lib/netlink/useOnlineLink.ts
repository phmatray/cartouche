import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { LinkCore } from './bridge';
import { closeRoom, hold, openRoom, plug, setSeat, useNet } from './session';

/** Past this without an answer (the other player gone, not merely paused), the game reads an unplugged cable. */
const GIVE_UP_MS = 20_000;

type Core = LinkCore & { set_link_remote(on: boolean): void; run_frame(): boolean };

/**
 * The player page's side of the online link cable (`?online=<room>`): joins the room, plugs the console in once
 * the ROM runs, tells the other player when this one is paused, and gives up on a transfer nobody answers.
 * `pump` must run after every frame.
 */
export function useOnlineLink(core: RefObject<Core | null>, power: number, code: string | null, running: boolean) {
  const [unplugged, setUnplugged] = useState(false);
  const [waiting, setWaiting] = useState(0); // ms our console has waited for the other one (0: not waiting)
  const [gaveUp, setGaveUp] = useState(0);
  const cable = useRef<ReturnType<typeof plug> | null>(null);
  const runningRef = useRef(running);
  useEffect(() => { runningRef.current = running; }, [running]);
  const on = !!code && !unplugged;
  const lockstep = useNet((s) => s.mode === 'lockstep'); // both consoles here (useLockstep): no bytes cross

  useEffect(() => {
    if (!code) return;
    const release = hold();
    openRoom(code);
    return release;
  }, [code]);

  useEffect(() => {
    const emu = core.current;
    if (!on || !power || !emu) return; // plugged in again on every power-on (a new console)
    let c: ReturnType<typeof plug> | null = null;
    if (!lockstep) {
      emu.set_link_remote(true);
      // The answer came: finish the stalled frame now (running the game only while it plays), and send what it says.
      const plugged = plug(emu, () => {
        if (!runningRef.current || document.visibilityState === 'hidden') return;
        emu.run_frame(); // up to the frame's end, or the next transfer (whose answer resumes us again)
        plugged.pump();
      });
      c = plugged;
    }
    cable.current = c;
    setSeat({ playing: true });
    return () => {
      c?.unplug();
      cable.current = null;
      setSeat({ playing: false, ready: false, paused: false });
    };
  }, [on, power, core, lockstep]);

  // Paused, or hidden (the frame loop stops in the background): the other console may wait on this one.
  useEffect(() => {
    if (!on) return;
    const tell = () => setSeat({ paused: !running || document.visibilityState === 'hidden' });
    tell();
    document.addEventListener('visibilitychange', tell);
    return () => document.removeEventListener('visibilitychange', tell);
  }, [on, running]);

  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => {
      const b = cable.current?.bridge;
      const w = b?.waitingSince ? performance.now() - b.waitingSince : 0;
      setWaiting(w);
      // Paused counts through a lost connection too: an iPhone that switches apps pauses first, then goes silent.
      const { phase, peer } = useNet.getState();
      const paused = peer?.paused && (phase === 'linked' || phase === 'lost');
      if (b && w > GIVE_UP_MS && !paused) { b.giveUp(); setGaveUp(Date.now()); }
    }, 250);
    return () => clearInterval(t);
  }, [on]);

  const pump = useCallback(() => cable.current?.pump(), []);
  /** Pull the cable: this game goes on alone (its transfers read 0xFF) and the room closes. */
  const unplug = () => {
    core.current?.set_link_remote(false);
    closeRoom();
    setUnplugged(true);
  };
  return { on, pump, waiting, gaveUp, unplug, bytes: () => cable.current?.bridge.bytes ?? 0, waited: () => cable.current?.bridge.waited ?? 0 };
}
