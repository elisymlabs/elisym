import { PRODUCT_NAME } from '../constants';
import { AskrMark } from './AskrMark';
import { ElisymLogo } from './ElisymLogo';

export function Logo() {
  return (
    <a href="/" className="rounded-8 flex items-center gap-10" aria-label={`${PRODUCT_NAME} home`}>
      <AskrMark className="size-28" />
      <span className="text-28 font-serif leading-none">{PRODUCT_NAME}</span>
      <span className="text-12 text-text-3 hidden items-center gap-6 sm:flex">
        by
        <ElisymLogo />
      </span>
    </a>
  );
}
