import { PRODUCT_NAME } from '../constants';
import { Eyebrow } from './Eyebrow';
import { Reveal } from './Reveal';

/** What visitors type, in their language and their way of writing an amount. */
// cspell:disable
const ROWS = [
  [
    { lang: 'en', text: 'Something warm under $80?' },
    { lang: 'ja', text: '1万円以内のおすすめは?' },
    { lang: 'es', text: '¿Un regalo por menos de 50 €?' },
    { lang: 'ko', text: '5만 원 이하로 추천해 주세요' },
    { lang: 'de', text: 'Gibt es das in Größe M?' },
  ],
  [
    { lang: 'zh', text: '有没有三百块以内的?' },
    { lang: 'fr', text: 'Livraison en Belgique ?' },
    { lang: 'pt', text: 'Qual é a política de troca?' },
    { lang: 'it', text: 'Arriva entro venerdì?' },
    { lang: 'nl', text: 'Is deze trui van merinowol?' },
  ],
];
// cspell:enable

interface Ask {
  lang: string;
  text: string;
}

interface RowProps {
  asks: Ask[];
  reverse: boolean;
}

function Row({ asks, reverse }: RowProps) {
  const bubble =
    'rounded-[22px] rounded-br-6 border border-line bg-surface px-20 py-12 text-16 sm:text-18 shrink-0';
  return (
    <div className="marquee overflow-hidden">
      <ul className={`marquee-track flex w-max gap-12 pr-12 ${reverse ? 'marquee-reverse' : ''}`}>
        {asks.map((ask) => (
          <li key={ask.lang} lang={ask.lang} className={bubble}>
            {ask.text}
          </li>
        ))}
        {asks.map((ask) => (
          <li key={`${ask.lang}-again`} lang={ask.lang} aria-hidden="true" className={bubble}>
            {ask.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Languages() {
  return (
    <section id="languages" className="py-96 sm:py-160">
      <Reveal className="mx-auto flex max-w-880 flex-col items-center gap-20 px-16 text-center">
        <Eyebrow>Every language</Eyebrow>
        <h2 className="text-48 sm:text-80 font-serif leading-[0.95]">
          Your visitors ask <em>in their own words.</em>
        </h2>
        <p className="text-18 text-text-2 max-w-640 leading-relaxed">
          {`${PRODUCT_NAME} answers in the visitor's language, whatever language your catalog is in. It reads prices the way people write them, including in Chinese, Japanese and Korean, so a budget is understood and a price is checked either way.`}
        </p>
      </Reveal>
      <div className="mt-56 flex flex-col gap-12">
        {ROWS.map((asks, index) => (
          <Row key={asks[0]?.lang} asks={asks} reverse={index % 2 === 1} />
        ))}
      </div>
    </section>
  );
}
