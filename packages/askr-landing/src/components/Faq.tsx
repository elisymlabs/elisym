import { PRODUCT_NAME } from '../constants';
import { Eyebrow } from './Eyebrow';
import { Reveal } from './Reveal';

const QUESTIONS = [
  {
    question: 'Do I need a developer?',
    answer:
      'No. Paste one line into your site, the same way you add any other script. On Shopify and WooCommerce, your products sync and Add to cart works without any code.',
  },
  {
    question: `Does ${PRODUCT_NAME} take payments or place orders?`,
    answer: `No. ${PRODUCT_NAME} sells nothing and never touches money. It sends the visitor to your product page or your own cart, and checkout stays exactly where it is.`,
  },
  {
    question: 'What happens when it does not know the answer?',
    answer:
      'It says so. It answers only from your catalog and the policies you published, and never invents a product, a discount or a spec.',
  },
  {
    question: 'Can it quote a wrong price?',
    answer:
      'Product cards always carry the price from your catalog. Every price the model writes in the text is checked against your catalog and policies first, and a wrong one is corrected or cut before the visitor sees it.',
  },
  {
    question: 'Can someone trick it with hidden instructions?',
    answer:
      'It is built not to follow them. Instructions hidden in a product description or typed by a visitor are read as data, not as instructions, and every price it writes is checked against your catalog either way.',
  },
  {
    question: 'Will it slow down my site?',
    answer:
      'The script loads asynchronously, after your page, and runs in its own shadow root, apart from your styles and scripts.',
  },
  {
    question: 'Do you keep the conversations?',
    answer:
      "No. A visitor's chat lasts up to 24 hours and then expires. The admin counts conversations and product clicks, not what was said.",
  },
  {
    question: 'Do I give you my Shopify or WooCommerce token?',
    answer:
      'No. Connectors read only what your shop already shows the public, the same pages and feeds a visitor or a search engine sees.',
  },
  {
    question: 'Which languages does it speak?',
    answer:
      "It answers in the visitor's language, whatever language your catalog is in, and reads prices as people write them, including in Chinese, Japanese and Korean.",
  },
  {
    question: 'Can I make it sound like my brand?',
    answer:
      "Yes. Set the assistant's voice and instructions in the admin: how it greets, how it talks, what it should always mention.",
  },
  {
    question: 'What if I want to leave?',
    answer:
      'Your settings are signed by your own key, and your products and policies are signed listings on Nostr, an open network. They stay yours.',
  },
];

export function Faq() {
  return (
    <section id="faq" className="mx-auto max-w-1200 px-16 pb-96 sm:px-24 sm:pb-160">
      <div className="grid gap-40 lg:grid-cols-[0.8fr_1.2fr]">
        <Reveal className="flex flex-col gap-16 lg:sticky lg:top-112 lg:self-start">
          <Eyebrow>FAQ</Eyebrow>
          <h2 className="text-48 sm:text-64 font-serif leading-[0.98]">
            Questions <em>stores ask.</em>
          </h2>
        </Reveal>
        <Reveal delay={1} className="border-line-2 border-b">
          {QUESTIONS.map((item) => (
            <details key={item.question} className="border-line-2 group border-t py-20">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-16 [&::-webkit-details-marker]:hidden">
                <span className="text-20 sm:text-24 font-serif">{item.question}</span>
                <span
                  aria-hidden="true"
                  className="border-line-2 group-hover:border-text group-open:bg-ink group-open:border-ink group-open:text-on-ink grid size-36 shrink-0 place-items-center rounded-full border transition-colors duration-300"
                >
                  <svg viewBox="0 0 16 16" className="size-14" fill="none" stroke="currentColor">
                    <path d="M2.5 8h11" strokeWidth="1.6" strokeLinecap="round" />
                    <path
                      d="M8 2.5v11"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      className="origin-center transition-transform duration-300 group-open:scale-y-0"
                    />
                  </svg>
                </span>
              </summary>
              <p className="text-16 text-text-2 mt-12 max-w-640 leading-relaxed">{item.answer}</p>
            </details>
          ))}
        </Reveal>
      </div>
    </section>
  );
}
