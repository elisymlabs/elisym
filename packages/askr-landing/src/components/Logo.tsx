import { ELISYM_URL, PRODUCT_NAME } from '../constants';
import { AskrLogo } from './AskrLogo';
import { ElisymLogo } from './ElisymLogo';
import { ExternalLink } from './ExternalLink';

export function Logo() {
  return (
    <span className="flex items-center gap-12">
      <a href="/" className="rounded-8 flex" aria-label={`${PRODUCT_NAME} home`}>
        <AskrLogo />
      </a>
      <ExternalLink
        href={ELISYM_URL}
        className="text-12 text-text-3 hover:text-text hidden items-center gap-6 sm:flex"
      >
        by
        <ElisymLogo />
      </ExternalLink>
    </span>
  );
}
