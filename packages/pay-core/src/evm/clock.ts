/**
 * One clock for every bound in this module.
 *
 * `Date.now()` steps when the machine's wall clock is corrected - an NTP step,
 * a VM resume, a container host adjusting its guests - and a step BACKWARD
 * extends anything measured against it by the size of the step. Every budget
 * and every staleness bound here is therefore measured on a clock that only
 * moves forward, and only durations are ever compared.
 */
export function monotonicNow(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}
