import { Button } from '../../components/Button';
import { type HandAnswerRead, type OrderCommand, shownAmount } from '../lib/orders';

interface Props {
  answer: HandAnswerRead;
  onAsk: (command: OrderCommand) => void;
  busy: boolean;
}

/**
 * An order the owner answered by hand. Its answer can be sent once more (the
 * node closes the order before it publishes, so an answer too few relays took
 * is sent again this way).
 */
export function HandAnswered({ answer, onAsk, busy }: Props) {
  let what = 'completed';
  let again: OrderCommand | undefined = { kind: 'complete', key: answer.key, again: true };
  if (answer.kind === 'refunded') {
    let amount = '';
    if (answer.amount !== null) {
      amount =
        answer.asset === null
          ? ` ${answer.amount} subunits`
          : ` ${shownAmount(answer.amount, answer.asset)}`;
    }
    what = `refunded${amount}${answer.tx === null ? '' : ` in ${answer.tx}`}`;
    again =
      answer.tx === null || answer.amount === null
        ? undefined
        : {
            kind: 'refund',
            key: answer.key,
            tx: answer.tx,
            amount: answer.amount,
            asset: answer.asset,
            again: true,
          };
  }
  return (
    <li className="border-line flex flex-col gap-4 border-b py-8">
      <p className="text-13 break-all">
        {answer.key}: {what}
      </p>
      {again === undefined ? null : (
        <Button disabled={busy} onClick={() => onAsk(again)} size="sm" className="self-start">
          Send the answer again
        </Button>
      )}
    </li>
  );
}
