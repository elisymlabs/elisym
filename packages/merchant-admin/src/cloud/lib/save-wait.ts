/**
 * Where a step's save stands (plan section 3, "Waiting for a save"), judged
 * by state, never by a cycle id, and only from a status read asked for after
 * the save: an older read says nothing of it.
 */
export type SaveVerdict = 'none' | 'waiting' | 'applied' | 'refused';

export function saveVerdict(input: {
  /** The status read asked for right after the save; undefined: nothing saved. */
  sentSeq: number | undefined;
  /** The read the status shown came from. */
  statusSeq: number;
  /** The store keeps what was saved. */
  kept: boolean;
  /** A save is still to apply. */
  pending: boolean;
}): SaveVerdict {
  if (input.sentSeq === undefined) {
    return 'none';
  }
  if (input.statusSeq < input.sentSeq) {
    return 'waiting';
  }
  if (input.kept) {
    return 'applied';
  }
  // Refused only when nothing is still to apply and the save is not kept.
  return input.pending ? 'waiting' : 'refused';
}
