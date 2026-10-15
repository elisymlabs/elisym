import { PRODUCT_NAME } from '../constants';
import { ElisymLogo } from './ElisymLogo';
import { PayCoreLogo } from './PayCoreLogo';

export function Logo() {
  return (
    <a href="/" className="flex items-center gap-10" aria-label={`${PRODUCT_NAME} home`}>
      <PayCoreLogo className="h-28 w-auto" />
      <span className="text-13 text-text-3 hidden items-center gap-6 sm:flex">
        by
        <ElisymLogo />
      </span>
    </a>
  );
}
