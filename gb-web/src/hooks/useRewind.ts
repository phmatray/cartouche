import { useRef, useState, useCallback } from 'react';
import { useSettingsStore } from '../store/settingsStore';

const CAPTURE_INTERVAL = 10; // frames between captures (1/6 s)
const REWIND_STEP_FRAMES = 5; // each rewound state is shown for 5 calls: rewinds at 2× real time, 12 steps a second

/** A save state plus the frame on screen when it was taken: save states hold no framebuffer, so
 *  loading one alone leaves the old picture up until the game draws again (never, while its LCD is off).
 *  Memory: ~92 KB per frame, 6 captures/s: ~5.5 MB for 10 s, ~33 MB for 60 s (plus the states). */
type Snapshot = { state: Uint8Array; frame: Uint8ClampedArray };

export function useRewind({
  saveState,
  loadState,
}: {
  saveState: () => Uint8Array | null;
  loadState: (data: Uint8Array, frame?: Uint8ClampedArray) => boolean;
}) {
  const rewindBufferSeconds = useSettingsStore((s) => s.rewindBufferSeconds);
  const bufferSize = Math.ceil(rewindBufferSeconds * 60 / CAPTURE_INTERVAL);
  const bufferRef = useRef<Snapshot[]>([]);
  const captureCounterRef = useRef(0);
  const rewindStepCounterRef = useRef(0);
  const isRewindingRef = useRef(false);
  const pendingFrameRef = useRef<Uint8ClampedArray | null>(null); // rewound on press, not drawn yet
  const [isRewinding, setIsRewinding] = useState(false);
  const [bufferFill, setBufferFill] = useState(0);

  const startRewind = useCallback(() => {
    if (isRewindingRef.current) return;
    const snap = bufferRef.current.pop();
    if (!snap) return;
    // The first step happens on press, so even a tap shorter than a frame rewinds; the next frame draws it.
    // A refused state (made before a restart onto another console): so is everything older, the buffer goes.
    if (!loadState(snap.state, snap.frame)) { bufferRef.current = []; setBufferFill(0); return; }
    pendingFrameRef.current = snap.frame;
    setBufferFill(bufferRef.current.length / bufferSize);
    isRewindingRef.current = true;
    setIsRewinding(true);
    rewindStepCounterRef.current = 0;
  }, [loadState, bufferSize]);

  const stopRewind = useCallback(() => {
    isRewindingRef.current = false;
    setIsRewinding(false);
    captureCounterRef.current = 0;
    pendingFrameRef.current = null; // released before the next frame: play simply goes on from the rewound state
  }, []);

  const wrapRunFrame = useCallback(
    (originalRunFrame: () => Uint8ClampedArray | null): Uint8ClampedArray | null => {
      if (isRewindingRef.current) {
        rewindStepCounterRef.current++;
        // Between steps the canvas keeps the last rewound frame (the one rewound on press is drawn first).
        if (rewindStepCounterRef.current < REWIND_STEP_FRAMES) {
          const pending = pendingFrameRef.current;
          pendingFrameRef.current = null;
          return pending;
        }
        rewindStepCounterRef.current = 0;

        const snap = bufferRef.current.pop();
        // Buffer exhausted, or a state that won't load (and nothing older will): auto-stop rewind
        if (!snap || !loadState(snap.state, snap.frame)) {
          bufferRef.current = [];
          isRewindingRef.current = false;
          setIsRewinding(false);
          setBufferFill(0);
          return originalRunFrame();
        }

        setBufferFill(bufferRef.current.length / bufferSize);
        return snap.frame;
      } else {
        let result = originalRunFrame();

        captureCounterRef.current++;
        if (captureCounterRef.current >= CAPTURE_INTERVAL) {
          captureCounterRef.current = 0;
          // result views WASM memory, which saveState() may grow (detaching the view): copy it first.
          // The copy also becomes the frame shown when this state is rewound to.
          if (result) result = new Uint8ClampedArray(result);
          const state = saveState();
          if (state && result) {
            bufferRef.current.push({ state, frame: result });
            while (bufferRef.current.length > bufferSize) {
              bufferRef.current.shift(); // drop oldest (several after the rewind length is lowered)
            }
            setBufferFill(bufferRef.current.length / bufferSize);
          }
        }

        return result;
      }
    },
    [saveState, loadState, bufferSize],
  );

  return { isRewinding, startRewind, stopRewind, wrapRunFrame, bufferFill };
}
