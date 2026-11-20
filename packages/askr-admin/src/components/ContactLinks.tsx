import { CONTACT_URL, FIND_STORE_ID_URL } from '../constants';

interface Props {
  /** The Store ID (npub) to quote, shown beside the link. */
  storeId: string;
}

const LINK = 'text-13 text-text-2 hover:text-text underline underline-offset-2';

/** Where to message us about a paid or larger plan, and the Store ID to name. */
export function ContactLinks({ storeId }: Props) {
  return (
    <p className="text-13 text-text-2 flex flex-wrap items-baseline gap-x-12 gap-y-4">
      <a className={`contact-link ${LINK}`} href={CONTACT_URL} target="_blank" rel="noreferrer">
        Message us
      </a>
      <span className="min-w-0">
        Store ID: <span className="font-mono break-all">{storeId}</span>
      </span>
      <a className={LINK} href={FIND_STORE_ID_URL} target="_blank" rel="noreferrer">
        Where else to find it
      </a>
    </p>
  );
}
