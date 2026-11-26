import { PRODUCT_NAME } from '../constants';
import { LEGAL_LINK_CLASS, LEGAL_NAME, PRIVACY_PATH } from '../legal';
import { ContactForm } from './ContactForm';
import { LegalPage } from './LegalPage';
import { LegalSection } from './LegalSection';
import { MailLink } from './MailLink';

/** The terms of service at /terms-of-service: the agreement between a merchant and the operator. */
export function TermsOfService() {
  return (
    <LegalPage
      title="Terms of service"
      summary={`The agreement between you, a store owner using ${PRODUCT_NAME}, and us. Please read it with our privacy policy.`}
    >
      <LegalSection id="about" title="1. About these terms">
        <p>
          {`${PRODUCT_NAME} is operated by ${LEGAL_NAME}, a sole trader (autónomo) in Spain ("we", "us"). These terms apply when you create a store in ${PRODUCT_NAME}, through the admin, the CLI or an AI agent acting for you, and while you use it. By doing so you accept them. ${PRODUCT_NAME} is for anyone who runs an online store, whether a business or an individual.`}
        </p>
        <p>
          How we handle personal data is in our{' '}
          <a href={PRIVACY_PATH} className={LEGAL_LINK_CLASS}>
            privacy policy
          </a>
          .
        </p>
      </LegalSection>

      <LegalSection id="service" title="2. The service">
        <p>
          {`${PRODUCT_NAME} is an AI shopping assistant for your store's websites. You add one script tag to your pages, and a chat answers your visitors' questions from your own products and policies and links them to your product pages and cart. You manage it in the admin or with the ${PRODUCT_NAME} CLI. Your products come from a file, from the admin, from a connector that reads your Shopify, WooCommerce or Google product feed on a schedule, or from your PayCore store.`}
        </p>
        <p>
          {`${PRODUCT_NAME} does not take orders, payments or returns: checkout stays on your site. If your products come from your PayCore store, a Buy button on their cards opens the PayCore checkout, a separate service with its own terms, on your pages; the payment goes on the blockchain to your store, never through ${PRODUCT_NAME}. Your store's settings, products and policies are published as signed, public listings on the open Nostr network, as described in the privacy policy.`}
        </p>
      </LegalSection>

      <LegalSection id="key" title="3. Your store and your secret key">
        <p>
          Your store is controlled by its secret key. Keep it safe and private: whoever has it
          controls your store, and we cannot recover it. If it is lost or leaked, you can replace it
          by proving through your own website that the store is yours, as the admin explains.
        </p>
        <p>
          Keep your contact email current if you give one: it is how we reach you about your plan
          and your store.
        </p>
      </LegalSection>

      <LegalSection id="plans" title="4. Plans and limits">
        <p>
          {`The plans, their prices and their limits are those on the ${PRODUCT_NAME} pricing page at the time you choose or renew a plan. Each plan has a number of conversations it is meant for, a product limit, a sync interval and a spending cap on AI models. Conversation numbers are approximate. When a store reaches its cap, the chat pauses until the cap resets instead of costing more.`}
        </p>
        <p>
          Every plan except Enterprise shows a &quot;Powered by {PRODUCT_NAME}&quot; line in the
          chat. The Free plan is for trying {PRODUCT_NAME} on your own store, with lower limits. We
          may limit how many stores can start on Free, and we may change or end the Free plan.
          Before Free ends for your store, we tell you by email if you gave us one, and otherwise
          with a notice on this website.
        </p>
      </LegalSection>

      <LegalSection id="billing" title="5. Paid plans and billing">
        <ul>
          <li>
            Paid plans are subscriptions billed in advance, monthly or yearly. You buy one yourself
            in the admin, or at the checkout link the {PRODUCT_NAME} CLI gives you, through Stripe
            Checkout; the plan starts once the payment goes through. Prices are set in US dollars;
            checkout may show and charge them in your local currency; a renewal charged in your
            local currency may differ with exchange rates.
          </li>
          <li>
            Paid plans are sold through Stripe as the merchant of record: checkout and your card
            statement show the sale as made through Link, Stripe&apos;s payment service. Stripe
            takes the payment, issues the receipt and supports payments and subscriptions at
            link.com.
          </li>
          <li>
            Prices on our site include the applicable tax: Stripe charges the price shown and states
            the tax it includes on the receipt.
          </li>
          <li>Refunds and payment disputes may be handled by Stripe under its own terms.</li>
          <li>
            If you are a consumer in the European Union or the United Kingdom, you can cancel a
            purchase within 14 days of getting access to it, as Link&apos;s terms describe: ask Link
            support for a refund and give &quot;cooling-off period&quot; as the reason.
          </li>
          <li>
            A subscription renews automatically at the end of each period until you cancel it.
          </li>
          <li>
            You can change or cancel your plan at any time with &quot;Manage billing&quot; in the
            admin (it opens Stripe&apos;s customer portal), at link.com, or by writing to us. After
            a cancel the plan stays active until the end of the period you paid for and is not
            renewed; the store then moves to the Free plan if Free has room, otherwise it is paused
            (pending) until you choose a plan. Your store&apos;s data is kept either way. Periods
            already paid are not refunded, unless the law requires it or Stripe refunds them under
            its terms.
          </li>
          <li>
            If a payment fails, Stripe tries it again for up to about a week, and your store keeps
            working on its plan meanwhile. If the payment still fails, the subscription ends and the
            store moves to the Free plan if Free has room, otherwise it is paused (pending) and the
            chat stops answering until you choose a plan. Your store&apos;s data is kept.
          </li>
          <li>
            Enterprise plans are agreed in writing, and that agreement prevails over these terms
            where they differ.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="use" title="6. Acceptable use">
        <p>You agree not to:</p>
        <ul>
          <li>use {PRODUCT_NAME} for a store that sells illegal goods or services;</li>
          <li>
            publish products, policies or settings that are unlawful, misleading, or that infringe
            someone else&apos;s rights;
          </li>
          <li>
            misuse the assistant: use it for anything other than helping your visitors with your
            store, try to make it produce harmful content, or flood it with automated requests;
          </li>
          <li>get around plan limits, or interfere with the service or other stores;</li>
          <li>resell or give access to {PRODUCT_NAME} to others without our written agreement.</li>
        </ul>
        <p>
          You are responsible for telling your own visitors about the assistant in your site&apos;s
          privacy notice. We may suspend a store that breaks these rules. The admin then shows the
          store as suspended, and we tell you why by email if you gave us one, unless the law or the
          safety of others prevents it.
        </p>
      </LegalSection>

      <LegalSection id="content" title="7. Your content">
        <p>
          Your products, policies and settings remain yours. You let us store, process and publish
          them, and give them to the AI models, as far as needed to run the service for your store.
        </p>
        <p>
          You are responsible for your catalog and policies being accurate, current and lawful:
          prices, stock, delivery, returns and anything else the assistant may repeat to your
          visitors.
        </p>
      </LegalSection>

      <LegalSection id="processing" title="8. Data processing">
        <p>
          {`When shoppers chat with the assistant on your site, ${PRODUCT_NAME} processes their personal data on your behalf, as your processor under article 28 of the GDPR. This section is the data processing agreement between you and us. Its subject matter, duration, nature and purpose, the kinds of personal data and the people concerned (your shoppers) are those described in section 3 of our privacy policy. We:`}
        </p>
        <ul>
          <li>
            process that data only to run the assistant for your store, as these terms describe, and
            not for any purpose of our own;
          </li>
          <li>
            keep it confidential, and give access only to those who need it to run the service;
          </li>
          <li>
            use the sub-processors listed in our privacy policy, bound by data protection
            obligations equivalent to these, and announce changes to that list there before they
            apply, so you can object or stop using {PRODUCT_NAME};
          </li>
          <li>
            help you answer requests from shoppers who exercise their data protection rights, as far
            as we hold anything about them;
          </li>
          <li>
            tell you without undue delay, by email if you gave us one, of a personal data breach
            that affects your shoppers;
          </li>
          <li>
            make available the information you need to show that these obligations are met, and
            allow reasonable audits of them;
          </li>
          <li>
            delete that data at the end of the service: chats are deleted within 24 hours anyway,
            and gone from the server&apos;s snapshots within 7 days, and the rest as the privacy
            policy describes;
          </li>
          <li>
            protect it with encrypted connections, end-to-end encryption of chats through the relay,
            encryption of the keys we hold for your store, and a database not reachable from the
            internet.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="answers" title="9. AI answers">
        <p>
          The assistant&apos;s answers are written by AI models from your catalog and policies. They
          can be wrong or incomplete. Your store&apos;s own pages, prices and policies prevail over
          anything the assistant says, and the chat tells visitors they are talking to an AI.
        </p>
      </LegalSection>

      <LegalSection id="availability" title="10. Availability and warranty">
        <p>
          We work to keep {PRODUCT_NAME} running, but we do not promise it will always be available
          or free of errors. We may change, add or remove features. Unless an Enterprise agreement
          says otherwise, the service is provided as it is, with no warranty beyond what the law
          requires.
        </p>
      </LegalSection>

      <LegalSection id="liability" title="11. Liability">
        <p>
          We are not liable for indirect losses, such as lost sales, profits or data. Our total
          liability to you for any claims about {PRODUCT_NAME} is limited to the fees you paid us in
          the 12 months before the claim. Nothing in these terms limits liability that the law does
          not allow to be limited, such as for wilful misconduct or gross negligence, and nothing in
          them limits the rights consumers have under mandatory law.
        </p>
      </LegalSection>

      <LegalSection id="ending" title="12. Ending">
        <p>
          You can stop using {PRODUCT_NAME} at any time: remove the script tag from your site,
          cancel any paid plan, and ask us to close your store. We may suspend or close a store that
          breaks these terms or is not paid. When a store is closed, we delete its data from our
          server and remove its events from our relay&apos;s database (a relay backup drops them
          when it is replaced), as the privacy policy describes; copies others made of public
          listings may remain.
        </p>
      </LegalSection>

      <LegalSection id="changes" title="13. Changes to these terms">
        <p>
          We may change these terms. At least 30 days before a change that matters takes effect, we
          tell you by email if you gave us one, and otherwise with a notice at the top of this page;
          we also change the date there. If you do not agree, you can stop using {PRODUCT_NAME} and
          cancel before the change applies.
        </p>
      </LegalSection>

      <LegalSection id="law" title="14. Law and contact">
        <p>
          These terms are governed by the laws of Spain. Disputes go to the courts of Spain, unless
          the law gives you the right to another court. If you are a consumer, you keep the
          protection of the mandatory law of the country where you live, and you may go to the
          courts of that country where the law gives you that right.
        </p>
        <p>
          Questions about these terms: write to <MailLink />, or use our <ContactForm />.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
