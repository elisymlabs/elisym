import { LEGAL_ADDRESS, LEGAL_NAME, LEGAL_NIF, LEGAL_STATUS } from '../legal';
import { MailLink } from './MailLink';

/** The operator's identification, at the end of each legal page: lines with no value are left out. */
export function LegalNotice() {
  const lines = [
    { term: 'Operator', value: LEGAL_NAME },
    { term: 'Status', value: LEGAL_STATUS },
    { term: 'NIF', value: LEGAL_NIF },
    { term: 'Address', value: LEGAL_ADDRESS },
  ].filter((line) => line.value.length > 0);
  return (
    <section
      aria-labelledby="legal-notice"
      className="border-line-2 rounded-16 bg-surface mt-56 border p-24"
    >
      <h2 id="legal-notice" className="text-20 font-medium">
        Legal notice
      </h2>
      <dl className="text-15 text-text-2 mt-16 grid gap-x-24 gap-y-8 sm:grid-cols-[max-content_1fr]">
        {lines.map((line) => (
          <div key={line.term} className="contents">
            <dt className="text-text font-medium">{line.term}</dt>
            <dd>{line.value}</dd>
          </div>
        ))}
        <div className="contents">
          <dt className="text-text font-medium">Email</dt>
          <dd>
            <MailLink />
          </dd>
        </div>
      </dl>
    </section>
  );
}
