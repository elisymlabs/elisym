import { AskrMark } from './AskrMark';
import { Wordmark } from './Wordmark';

/**
 * The Askr logo at the header's size, as the admin sets it: the wordmark 24px tall, the mark
 * 1.12 times that and as wide as its rim, 0.3 of the height apart.
 */
export function AskrLogo() {
  return (
    <span className="inline-flex items-center gap-[7.2px]">
      <AskrMark tight className="h-[26.88px] w-[28.44px] flex-none" />
      <Wordmark className="h-24 w-auto" />
    </span>
  );
}
