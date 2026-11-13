import { PRODUCT_NAME } from '../constants';
import { SectionHeading } from './SectionHeading';

/** What visitors type, in their language and their way of writing an amount. */
// cspell:disable
const ASKS = [
  { lang: 'en', text: 'Something warm under $80?' },
  { lang: 'es', text: '¿Un regalo por menos de 50 €?' },
  { lang: 'de', text: 'Gibt es das in Größe M?' },
  { lang: 'ja', text: '1万円以内のおすすめは?' },
  { lang: 'zh', text: '有没有三百块以内的?' },
  { lang: 'ko', text: '5만 원 이하로 추천해 주세요' },
  { lang: 'fr', text: 'Livraison en Belgique ?' },
  { lang: 'pt', text: 'Qual é a política de troca?' },
];
// cspell:enable

export function Languages() {
  return (
    <section id="languages" className="mx-auto max-w-1200 px-16 py-80 sm:px-24 sm:py-112">
      <SectionHeading
        eyebrow="Every language"
        title="Your visitors ask in their own words"
        centered
      >
        {`${PRODUCT_NAME} answers in the visitor's language, whatever language your catalog is in. It reads prices the way people write them, including amounts in Chinese, Japanese and Korean, so a budget is understood and a price is checked either way.`}
      </SectionHeading>
      <ul className="mx-auto mt-48 flex max-w-920 flex-wrap justify-center gap-10">
        {ASKS.map((ask) => (
          <li
            key={ask.lang}
            lang={ask.lang}
            className="rounded-16 border-line bg-surface text-15 rounded-br-6 border px-16 py-10"
          >
            {ask.text}
          </li>
        ))}
      </ul>
    </section>
  );
}
