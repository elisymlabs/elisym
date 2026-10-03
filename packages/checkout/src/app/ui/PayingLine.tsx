import type { Paying } from '../session';
import { payingLine } from './text';

interface Props {
  paying: Paying | undefined;
}

export function PayingLine({ paying }: Props) {
  return paying === undefined ? null : <p class="paying">{payingLine(paying)}</p>;
}
