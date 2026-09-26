import { useRef, useState, useCallback } from 'react';
import { useSettingsStore } from '../store/settingsStore';

const CAPTURE_INTERVAL = 10; // frames between captures (1/6 s)
const REWIND_STEP_FRAMES = 5; // each rewound state is shown for 5 calls: rewinds at 2× real time, 12 steps a second

export function useRewind({
  saveState,
  loadState,
  framebufferSnapshot,
}: {
  saveState: () => Uint8Array | null;
  loadState: (data: Uint8Array) => boolean;
  framebufferSnapshot: () => Uint8Array | null;
}) {
  const rewindBufferSeconds = useSettingsStore((s) => s.rewindBufferSeconds);
  const bufferSize = Math.ceil(rewindBufferSeconds * 60 / CAPTURE_INTERVAL);
  const bufferRef = useRef<Uint8Array[]>([]);
  const captureCounterRef = useRef(0);
  const rewindStepCounterRef = useRef(0);
  const isRewindingRef = useRef(false);
  const [isRewinding, setIsRewinding] = useState(false);
  const [bufferFill, setBufferFill] = useState(0);

  const startRewind = useCallback(() => {
    if (bufferRef.current.length === 0) return;
    isRewindingRef.current = true;
    setIsRewinding(true);
    rewindStepCounterRef.current = 0;
  }, []);

  const stopRewind = useCallback(() => {
    isRewindingRef.current = false;
    setIsRewinding(false);
    captureCounterRef.current = 0;
  }, []);

  const wrapRunFrame = useCallback(
    (originalRunFrame: () => Uint8ClampedArray | null): Uint8ClampedArray | null => {
      if (isRewindingRef.current) {
        rewindStepCounterRef.current++;
        if (rewindStepCounterRef.current < REWIND_STEP_FRAMES) {
          // Hold on current state a few frames for visible rewind effect
          const snap = framebufferSnapshot();
          return snap ? new Uint8ClampedArray(snap.buffer, snap.byteOffset, snap.length) : null;
        }
        rewindStepCounterRef.current = 0;

        const state = bufferRef.current.pop();
        if (!state) {
          // Buffer exhausted — auto-stop rewind
          isRewindingRef.current = false;
          setIsRewinding(false);
          setBufferFill(0);
          return originalRunFrame();
        }

        loadState(state);
        setBufferFill(bufferRef.current.length / bufferSize);
        const snap = framebufferSnapshot();
        return snap ? new Uint8ClampedArray(snap.buffer, snap.byteOffset, snap.length) : null;
      } else {
        let result = originalRunFrame();

        captureCounterRef.current++;
        if (captureCounterRef.current >= CAPTURE_INTERVAL) {
          captureCounterRef.current = 0;
          // result views WASM memory, which saveState() may grow (detaching the view): copy it first.
          if (result) result = new Uint8ClampedArray(result);
          const state = saveState();
          if (state) {
            bufferRef.current.push(state);
            if (bufferRef.current.length > bufferSize) {
              bufferRef.current.shift(); // drop oldest
            }
            setBufferFill(bufferRef.current.length / bufferSize);
          }
        }

        return result;
      }
    },
    [saveState, loadState, framebufferSnapshot, bufferSize],
  );

  return { isRewinding, startRewind, stopRewind, wrapRunFrame, bufferFill };
}
