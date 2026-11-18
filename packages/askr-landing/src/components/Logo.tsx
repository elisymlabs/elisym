import { PRODUCT_NAME } from '../constants';
import { AskrLogo } from './AskrLogo';
import { ElisymLogo } from './ElisymLogo';

export function Logo() {
  return (
    <a href="/" className="rounded-8 flex items-center gap-12" aria-label={`${PRODUCT_NAME} home`}>
      <AskrLogo />
      <span className="text-12 text-text-3 hidden items-center gap-6 sm:flex">
        by
        <ElisymLogo />
      </span>
    </a>
  );
}
