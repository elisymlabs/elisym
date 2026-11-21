import { CONTACT_REDIRECT_URL } from '../constants';
import { LEGAL_LINK_CLASS } from '../legal';
import { ExternalLink } from './ExternalLink';

/** Our request form, through this site's `/contact` redirect, as a link in a legal page's text. */
export function ContactForm() {
  return (
    <ExternalLink href={CONTACT_REDIRECT_URL} className={LEGAL_LINK_CLASS}>
      request form
    </ExternalLink>
  );
}
