import { useRef, useCallback, useEffect, useState } from 'react';
import { AudioEngine } from '../audio/AudioEngine';
import { useSettingsStore } from '../store/settingsStore';

export function useAudio() {
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
  const ensureStarted = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;
    const fresh = !engine.getContextState();
    await engine.init();
    if (fresh && !mutedRef.current) engine.setVolume(useSettingsStore.getState().masterVolume / 100);
    await engine.resume();
  }, []);

  // Settings › Audio › Mute when the tab is hidden.
  useEffect(() => {
    const onVis = () => {
      if (!useSettingsStore.getState().muteWhenHidden || mutedRef.current) return;
      if (document.visibilityState === 'hidden') engineRef.current?.mute();
      else engineRef.current?.unmute(useSettingsStore.getState().masterVolume / 100);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

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
