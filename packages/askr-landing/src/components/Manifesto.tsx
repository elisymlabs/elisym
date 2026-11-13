import { PRODUCT_NAME } from '../constants';
import { Reveal } from './Reveal';

export function Manifesto() {
  return (
    <section id="manifesto" className="mx-auto max-w-1200 px-16 py-96 sm:px-24 sm:py-160">
      <Reveal>
        <h2 className="text-40 sm:text-64 font-serif leading-[1.05] tracking-[-0.01em]">
          {`${PRODUCT_NAME} is the shop assistant who has read every listing and every policy you published.`}{' '}
          <span className="text-text-3 italic">And nothing else.</span>
        </h2>
      </Reveal>
      <Reveal delay={1} className="mt-40 grid gap-24 sm:grid-cols-3">
        {[
          ['Answers', 'from your catalog and policies, in your voice'],
          ['Recommends', 'by need and budget, with the reason why'],
          ['Hands off', 'to your product page or your own cart'],
        ].map(([verb, rest]) => (
          <p
            key={verb}
            className="border-line-2 text-16 text-text-2 border-t pt-16 leading-relaxed"
          >
            <span className="text-text font-medium">{verb}</span> {rest}.
          </p>
        ))}
      </Reveal>
    </section>
  );
}
