import { useRef, useCallback, useEffect, useState } from 'react';
import { AudioEngine } from '../audio/AudioEngine';
import { useSettingsStore } from '../store/settingsStore';

/** `running`: the game runs. The audio device is suspended otherwise, and while the page is hidden. */
export function useAudio(running: boolean) {
  const engineRef = useRef<AudioEngine | null>(null);
  const storedVolume = useSettingsStore((s) => s.masterVolume);
  const [muted, setMuted] = useState(false);
  const [volume, setVolumeState] = useState(() => storedVolume / 100);

  useEffect(() => {
    engineRef.current = new AudioEngine();
    return () => {
      engineRef.current?.destroy();
      engineRef.current = null;
    };
  }, []);

  const mutedRef = useRef(false);
  useEffect(() => { mutedRef.current = muted; }, [muted]);
  const runningRef = useRef(running);
  const sync = useCallback(() => engineRef.current?.setWanted(runningRef.current && document.visibilityState === 'visible'), []);
  useEffect(() => { runningRef.current = running; sync()?.catch(() => {}); }, [running, sync]);
  /** `run`: the caller is about to start the game (Play), so the sound resumes inside its gesture, as iOS requires. */
  const ensureStarted = useCallback(async (run = false) => {
    const engine = engineRef.current;
    if (!engine) return;
    if (run) runningRef.current = true;
    const fresh = !engine.getContextState();
    await engine.init();
    if (fresh && !mutedRef.current) engine.setVolume(useSettingsStore.getState().masterVolume / 100);
    await sync();
  }, [sync]);

  // A hidden page runs no frames (requestAnimationFrame stops): the audio device rests with it.
  useEffect(() => {
    const onVis = () => { sync()?.catch(() => {}); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [sync]);

  const feedSamples = useCallback((samples: Float32Array) => {
    engineRef.current?.feedSamples(samples);
  }, []);

  const setVolume = useCallback((v: number) => {
    setVolumeState(v);
    engineRef.current?.setVolume(v);
  }, []);

  const toggleMute = useCallback(() => {
    setMuted(prev => {
      if (prev) {
        engineRef.current?.unmute(volume);
      } else {
        engineRef.current?.mute();
      }
      return !prev;
    });
  }, [volume]);

  return { ensureStarted, feedSamples, muted, toggleMute, volume, setVolume };
}
