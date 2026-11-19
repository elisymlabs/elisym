import { PRODUCT_NAME } from '../constants';
import { Reveal } from './Reveal';
import { ScrollWords } from './ScrollWords';

const VERBS = [
  ['Answers', 'questions about products, shipping, returns and warranty'],
  ['Recommends', 'the right product for each need and budget, and says why'],
  ['Sends', 'shoppers to the product page or straight to your cart'],
];

export function Manifesto() {
  return (
    <section id="manifesto" className="mx-auto max-w-1440 px-16 py-120 sm:px-32 sm:py-200">
      <h2 className="sr-only">What {PRODUCT_NAME} is</h2>
      <ScrollWords
        text={`A shopper with a question rarely writes to support. They leave. ${PRODUCT_NAME} answers them on the spot, from every product and policy you published,`}
        coda="and nothing else."
        className="font-serif text-[clamp(2.5rem,5.6vw,6rem)] leading-[1.02] tracking-[-0.02em]"
      />
      <Reveal className="mt-64 grid gap-24 sm:grid-cols-3">
        {VERBS.map(([verb, rest], index) => (
          <p key={verb} className="border-text text-16 text-text-2 border-t pt-16 leading-relaxed">
            <span className="text-text-3 mr-10 font-mono text-[12px]">{`0${index + 1}`}</span>
            <span className="text-text font-medium">{verb}</span> {rest}.
          </p>
        ))}
      </Reveal>
    </section>
  );
}
