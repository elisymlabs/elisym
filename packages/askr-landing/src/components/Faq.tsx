import { PRODUCT_NAME } from '../constants';
import { SectionHeading } from './SectionHeading';

const QUESTIONS = [
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
      'Your catalog, policies and settings are signed by your keys and live on Nostr, an open network. They stay yours.',
  },
];

export function Faq() {
  return (
    <section id="faq" className="mx-auto max-w-880 px-16 py-80 sm:px-24 sm:py-112">
      <SectionHeading eyebrow="FAQ" title="Questions stores ask" centered />
      <div className="mt-48 flex flex-col gap-12">
        {QUESTIONS.map((item) => (
          <details
            key={item.question}
            className="rounded-16 border-line bg-surface group border px-20 py-16 open:pb-20"
          >
            <summary className="text-16 flex cursor-pointer list-none items-center justify-between gap-16 font-medium [&::-webkit-details-marker]:hidden">
              <h3>{item.question}</h3>
              <span
                aria-hidden="true"
                className="text-text-3 text-20 transition group-open:rotate-45"
              >
                +
              </span>
            </summary>
            <p className="text-15 text-text-2 mt-12 leading-relaxed">{item.answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}
