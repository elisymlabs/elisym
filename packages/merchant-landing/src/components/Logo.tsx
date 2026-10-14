import { PRODUCT_NAME } from '../constants';
import { ElisymLogo } from './ElisymLogo';
import { LogoMark } from './LogoMark';

export function Logo() {
  return (
    <a href="/" className="flex items-center gap-10" aria-label={`${PRODUCT_NAME} home`}>
      <LogoMark className="size-28" />
      <span className="flex items-center gap-8">
        <span className="text-16 font-semibold tracking-tight">{PRODUCT_NAME}</span>
        <span className="text-13 text-text-3 hidden items-center gap-6 sm:flex">
          by
          <ElisymLogo />
        </span>
      </span>
    </a>
  );
}
