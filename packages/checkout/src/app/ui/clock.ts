import { useEffect, useState } from 'preact/hooks';

/** The device clock in unix seconds, the unit every view time field uses. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** The clock, ticking every second while `running` (a countdown on screen). */
export function useNow(running: boolean): number {
  const [now, setNow] = useState(nowSeconds);
  useEffect(() => {
    if (!running) {
      return undefined;
    }
    setNow(nowSeconds());
    const timer = setInterval(() => setNow(nowSeconds()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return running ? now : nowSeconds();
}

/** Seconds left of a countdown read at `at`, as of `now` (never below 0). */
export function secondsLeft(countdown: { seconds: number; at: number }, now: number): number {
  return Math.max(0, countdown.seconds - (now - countdown.at));
}
