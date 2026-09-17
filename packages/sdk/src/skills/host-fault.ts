/**
 * The agent failed at its own end of the job, before the skill could.
 *
 * A class rather than a sentence the runtime matches on. The health gate treats
 * this as "not the operator's API key", which is a decision worth having and
 * therefore worth forging: an ordinary `ScriptExecutionError` carries the
 * SCRIPT's own stderr in `detail` - and for an LLM proxy, stdout is a
 * completion the buyer steers - so any prefix a skill could print would be a
 * switch for its own circuit breaker. Only code inside this SDK constructs one.
 */
export class HostScratchError extends Error {
  /** What the filesystem said, for the operator log. Never sent to a customer. */
  readonly detail: string;

  constructor(detail: string) {
    super('the agent could not create scratch space for this job');
    this.name = 'HostScratchError';
    this.detail = detail;
  }
}

/**
 * Type guard by name and shape rather than `instanceof`.
 *
 * Each SDK entry point is its own bundle (`splitting: false`), so the class the
 * skills throw is a different class object from the one a consumer imports and
 * `instanceof` across the two is false however the source reads.
 */
export function isHostScratchError(value: unknown): value is HostScratchError {
  return (
    value instanceof Error &&
    value.name === 'HostScratchError' &&
    typeof (value as HostScratchError).detail === 'string'
  );
}
