/**
 * Who runs Askr, as the legal pages name it (the identification Spain's LSSI, art. 10, asks
 * for), in one place. The legal notice leaves out any line whose value is empty.
 */
export const LEGAL_NAME = 'Ihar Perahudau';
export const LEGAL_STATUS = 'Sole trader (autónomo) in Spain';
export const LEGAL_EMAIL = 'nata@elisym.network';
/** The NIF (an NIE, as a sole trader), shown in the legal notice. */
export const LEGAL_NIF = 'Y8956771X';
/** The postal address, shown in the legal notice. */
export const LEGAL_ADDRESS =
  'Calle Isora 18, 0805, Costa Adeje, 38678 Adeje, Santa Cruz de Tenerife, Spain';

/** When the privacy policy and the terms last changed, as both pages say it. */
export const LEGAL_LAST_UPDATED = '21 November 2026';

/** The pages' paths on this site; `vercel.json` serves them without `.html` (`cleanUrls`). */
export const PRIVACY_PATH = '/privacy';
export const TERMS_PATH = '/terms-of-service';

/** A link inside a legal page's text. */
export const LEGAL_LINK_CLASS = 'text-text underline underline-offset-2 hover:text-text-2';
