import { useRef, useEffect } from 'react';

export function useAnimationFrame(
  callback: () => void,
  active: boolean
) {
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (!active) return;
    let id = 0;
    const animate = () => {
      callbackRef.current();
      id = requestAnimationFrame(animate);
    };
    id = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(id);
  }, [active]);
}
