import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Countdown for rate-limited actions such as "resend email".
 *
 * A visible countdown is the point: a resend button that silently does nothing
 * for 60 seconds gets clicked five times and reads as broken.
 */
export function useCooldown(seconds: number) {
  const [remaining, setRemaining] = useState(0);
  const intervalRef = useRef<number | null>(null);

  const clear = useCallback(() => {
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const start = useCallback(() => {
    clear();
    setRemaining(seconds);
    intervalRef.current = window.setInterval(() => {
      setRemaining((value) => {
        if (value <= 1) {
          clear();
          return 0;
        }
        return value - 1;
      });
    }, 1000);
  }, [seconds, clear]);

  useEffect(() => clear, [clear]);

  return { remaining, start, active: remaining > 0 };
}
