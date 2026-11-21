import { LEGAL_EMAIL, LEGAL_LINK_CLASS } from '../legal';

/** The operator's email address as a mail link. */
export function MailLink() {
  return (
    <a href={`mailto:${LEGAL_EMAIL}`} className={LEGAL_LINK_CLASS}>
      {LEGAL_EMAIL}
    </a>
  );
}
