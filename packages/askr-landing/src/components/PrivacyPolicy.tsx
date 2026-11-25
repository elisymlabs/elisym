import { ADMIN_URL, PRODUCT_NAME } from '../constants';
import { LEGAL_EMAIL, LEGAL_LINK_CLASS, LEGAL_NAME, TERMS_PATH } from '../legal';
import { ContactForm } from './ContactForm';
import { ExternalLink } from './ExternalLink';
import { LegalPage } from './LegalPage';
import { LegalSection } from './LegalSection';
import { MailLink } from './MailLink';

/** The privacy policy at /privacy: what Askr processes about store owners and shoppers. */
export function PrivacyPolicy() {
  return (
    <LegalPage
      title="Privacy policy"
      summary={`What personal data ${PRODUCT_NAME} processes, why, where it goes and how long it is kept. It covers two groups of people: store owners who use ${PRODUCT_NAME} (merchants), and visitors who chat with the assistant on a store's website (shoppers).`}
    >
      <LegalSection id="who" title="1. Who we are">
        <p>
          {`${PRODUCT_NAME} is an AI shopping assistant that online stores add to their own websites. It is operated by ${LEGAL_NAME}, a sole trader (autónomo) in Spain ("we", "us"). Our full details are in the legal notice at the end of this page.`}
        </p>
        <p>
          For anything about this policy or your data, write to <MailLink />, or use our{' '}
          <ContactForm />.
        </p>
        <p>
          {`We are responsible for the data of merchants. When a shopper chats with the assistant on a store's site, we process that chat on the store's behalf, as its processor (section 8 of our terms of service), only to run the assistant; the store chose to add ${PRODUCT_NAME} to its site and should tell its own visitors about it in its privacy notice.`}
        </p>
      </LegalSection>

      <LegalSection id="merchants" title="2. Merchants: what we keep">
        <p>
          {`There is no account with a name or a password. Your store is a key pair: the Store ID is its public key (an "npub"), and you sign in to the admin or the ${PRODUCT_NAME} CLI with its secret key. We keep:`}
        </p>
        <ul>
          <li>
            <strong className="text-text font-medium">Your Store ID</strong>, its status (pending,
            active or suspended), its plan and when it was created or started on Free.
          </li>
          <li>
            <strong className="text-text font-medium">Your contact email</strong>, if you give one.
            We use it to write to you about your plan, its budget and your store. It is kept only on
            our server and never published.
          </li>
          <li>
            <strong className="text-text font-medium">The settings you sign</strong>: the store and
            assistant names, the catalog language, your store's websites and the other assistant
            settings, plus your products, policies and which keys may publish products for your
            store. These are also published, see section 4.
          </li>
          <li>
            <strong className="text-text font-medium">Two keys we hold for your store</strong>: the
            assistant's key (it reads and answers chats) and a catalog key (it publishes products
            from a connector). Their secret parts are encrypted in our database with AES-256-GCM
            under a master key that is kept outside the database and its dumps.
          </li>
          <li>
            <strong className="text-text font-medium">Your connector</strong>, if you set one up:
            the platform (Shopify, WooCommerce or a Google product feed), your shop's address, the
            currency, whether policies are imported, and the result and time of the last sync. A
            connector reads only what your shop already shows the public.
          </li>
          <li>
            <strong className="text-text font-medium">Usage</strong>: what the assistant spent each
            day on AI models, against your plan's budget; the number of conversations; and per day
            the conversations started, questions answered, product pages opened and add to cart
            presses from the assistant's product cards, with opens and presses also counted per
            product. These are counts: they do not say who chatted.
          </li>
          <li>
            <strong className="text-text font-medium">Key and site history</strong>: each website
            your settings have listed, with when we first and last saw it, and any replacement of
            your secret key (old and new Store ID, and when). We use these to let you prove a store
            is yours if you lose your key.
          </li>
          <li>
            <strong className="text-text font-medium">Admin requests</strong>: every request the
            admin or the CLI sends is signed with your key. We keep each request's id only until the
            request expires, so it cannot be replayed.
          </li>
          <li>
            <strong className="text-text font-medium">Your IP address</strong>: our server receives
            it with every admin request, and our relay when the admin reads your store&apos;s
            listings. We use it only to limit how many stores can be created and how many key
            recoveries can be started from one address per hour. It is held in the server&apos;s
            memory for that count and never written to our database.
          </li>
          <li>
            <strong className="text-text font-medium">Logs</strong>: our servers and relay keep no
            access or connection logs. Their logs never contain IP addresses; they may contain Store
            IDs and error details, are capped in size and overwritten, and also sit in the
            server&apos;s 7-day snapshots.
          </li>
        </ul>
        <p>
          Your secret key is made in your browser (or by the CLI on your computer) and is never sent
          to us. If you leave &quot;Remember my key on this device&quot; ticked in the admin, it is
          kept in that browser, encrypted, as described in section 6. We cannot recover a lost
          secret key.
        </p>
        <p>
          <strong className="text-text font-medium">Paid plans.</strong>
          {` Paid plans are sold through Stripe as the merchant of record (shown as "Sold through Link"). You buy a paid plan yourself in the admin, or at the checkout link the ${PRODUCT_NAME} CLI gives you, through Stripe Checkout. You give your payment details to Stripe, not to us: ${PRODUCT_NAME} never sees or stores your full card number. Stripe shares with us, in our Stripe account, your name, email address, billing address, the plan, its billing period, payment status and invoices, and the card brand and last digits. Our server keeps only your Stripe customer ID; for each subscription, its ID, status, plan, billing period, whether it is set to cancel, when Stripe created it, when its current period ends and when we last updated it; and the ID of the last checkout your store opened, all linked to your store's public key (its Store ID). It also keeps the IDs and types of the Stripe events it received, and log lines that name your store and the event. Your card details never reach it.`}
        </p>
        <p>
          <strong className="text-text font-medium">The Askr app for Shopify.</strong>
          {` If you add ${PRODUCT_NAME} to a Shopify store through our Shopify app, we also keep your shop's myshopify.com address and Shopify ID, its primary domain, when the app was installed or uninstalled, and the access tokens Shopify gives the app, encrypted like the store keys. The app asks Shopify only to read products and legal policies: it reads your products with their variants, prices, availability and images, your refund, shipping, privacy and terms of service pages, and your shop's name, currency, primary domain and primary language. It reads no customer, order or payment data. We hold a third key for your store, the app's delegate key, encrypted the same way: it signs your store's settings. We write your Store ID to the app's data in your shop, so your theme can load the assistant. Your owner key is made in your browser inside your Shopify admin and never sent to us. Shopify's session tokens name the staff member using the app; we use them to check each request and to get the app's access token from Shopify, and never keep them. Shopify also tells us when the app is uninstalled or the shop changes: we keep only that a notice came (its id, topic and shop) for 30 days, never what it said.`}
        </p>
        <p>
          <strong className="text-text font-medium">Why.</strong> We use this data to provide the
          service you signed up for (our contract with you), to keep plan limits and stop abuse (our
          legitimate interest in a working, fair service), and to keep the billing records the law
          requires (a legal obligation).
        </p>
        <p>
          <strong className="text-text font-medium">How long.</strong> We keep a store&apos;s data
          for as long as the store exists. Ask us to close your store and we delete its data from
          our server and remove its events (settings, products and policies) from our relay&apos;s
          database. Copies that others made of those public listings may remain. The store&apos;s
          data then leaves our database dumps as they roll over (section 5). Billing records are
          kept for as long as Spanish tax and accounting law requires. When you uninstall the
          Shopify app, your store goes back to pending and the Shopify tokens are deleted; 48 hours
          later, when Shopify asks apps to erase the shop&apos;s data, we delete the store and its
          Shopify record from our server and remove its settings, products and policies from our
          relay. The events your own owner key signed stay on the relay. If you revoked the
          app&apos;s delegate key with your owner key, so you manage the store yourself, we only
          unlink the store from the shop and keep it. When Shopify asks about a shop&apos;s
          customers, there is nothing we can find: nothing {PRODUCT_NAME} keeps is linked to a
          Shopify customer, and a shopper&apos;s chat is anonymous (section 3).
        </p>
      </LegalSection>

      <LegalSection id="shoppers" title="3. Shoppers: what happens when you chat">
        <p>With each question, the chat on a store&apos;s site sends:</p>
        <ul>
          <li>your message (up to 2,000 characters);</li>
          <li>
            the address of the page you are on, as the site and path only: never the query
            (?&hellip;) or fragment (#&hellip;) part;
          </li>
          <li>your browser&apos;s language;</li>
          <li>
            a random chat key the chat made in your browser for this store. It is not linked to your
            name, email or any account.
          </li>
        </ul>
        <p>
          <strong className="text-text font-medium">How it travels.</strong>
          {` Your messages and the answers are encrypted end to end between your browser and the ${PRODUCT_NAME} assistant on our server. On the way they pass through the elisym relay (relay.elisym.network), which we run for ${PRODUCT_NAME} and other elisym services at Hetzner in Ashburn, Virginia, United States, and which holds them only in encrypted form, marked to expire when your chat session ends.`}
        </p>
        <p>
          <strong className="text-text font-medium">Your IP address.</strong> Our server and our
          relay receive your IP address with every request, as any website does: when the page loads
          the chat script, when the chat asks for a session pass, when you open a product or press
          add to cart from a card, and on the chat&apos;s connection to relay.elisym.network. Our
          server uses it only to limit how many requests can come from one address per minute. It is
          held in the server&apos;s memory for that count and never written to our database. Our
          servers and relay keep no access or connection logs. Their logs never contain IP
          addresses; they may contain Store IDs and error details, are capped in size and
          overwritten, and also sit in the server&apos;s 7-day snapshots. The relay stores no IP
          address with the messages it holds.
        </p>
        <p>
          <strong className="text-text font-medium">The AI model.</strong>
          {` To answer, our server sends the conversation so far, the store's products and policy passages that fit your question, the product whose page you are on (if any) and your language to an AI model. It goes through OpenRouter (United States), which we allow to use only the hosts we name, all in the United States or the European Union, and never a host in China. We ask OpenRouter to use only hosts that do not collect the data, for example to train models. Today the model is DeepSeek V4.1 Flash, run by Together AI, Fireworks AI, Baseten or DeepInfra. If it fails, the same request goes to Claude Haiku 5.5, run by Anthropic or Amazon Bedrock, and then to gpt-oss-120b, run by Together AI or Groq. We may change models and hosts, keeping them in the United States or the European Union, and announce changes on this page before they apply.`}
        </p>
        <p>
          <strong className="text-text font-medium">What we keep, and for how long.</strong> A chat
          session lasts up to 24 hours from your first message. During it, our database holds your
          messages, the answers and the policy passages used, so the assistant can follow the
          conversation. When the session ends, it is deleted automatically: we keep no transcript
          archive, and the store cannot read your chats. We also keep, per chat key, how many
          questions it asked today, for the store&apos;s daily limit per person; this count is
          deleted when the day ends (UTC). Since 21 November 2026, our nightly database dumps
          contain no chat messages. Hetzner takes a daily snapshot of the whole server, which
          captures the database as it is, and keeps each for 7 days, so a chat from the last 24
          hours can remain in them for up to 7 days, and is then gone. What stays after a chat is
          only the store&apos;s counts in section 2, which do not say who chatted.
        </p>
        <p>
          The assistant is an AI, and the chat always says so. It cannot take orders or payments:
          checkout stays on the store&apos;s own site. Product cards show the store&apos;s product
          pictures, which your browser loads, with no referrer, from wherever the store hosts its
          images (often its shop platform&apos;s image service).
        </p>
        <p>
          <strong className="text-text font-medium">Why.</strong>
          {` To answer the questions you ask the store's assistant: our and the store's legitimate interest in providing the assistant you chose to use, and in keeping it safe from abuse.`}
        </p>
      </LegalSection>

      <LegalSection id="public" title="4. What is public by design">
        <p>
          {`A store's settings, products and policies, and which keys may publish its products, are signed and published to the elisym relay (relay.elisym.network) on the open Nostr network. Anyone can read them, the way anyone can read a store's own product pages. A merchant's contact email is never published. Chats are not public: they are encrypted and expire.`}
        </p>
        <p>
          When a merchant removes a product, it is published again marked hidden, so {PRODUCT_NAME}{' '}
          and its chat stop using it, along with a deletion event that Nostr clients supporting
          deletions honour. The listing itself may stay readable on relays. When a merchant asks us
          to close the store, we also remove its events from our relay&apos;s database. We may take
          occasional manual backups of the relay&apos;s data for recovery, and keep at most the
          latest one: closed stores&apos; events and expired chats leave it when it is replaced.
          Copies that others made of public listings may remain outside our control.
        </p>
      </LegalSection>

      <LegalSection id="processors" title="5. Who helps us, and where">
        <p>
          We do not sell personal data and we show no ads. These providers process data for us, or,
          where noted, receive it as controllers in their own right:
        </p>
        <ul>
          <li>
            Hetzner Online GmbH (Hetzner Cloud) runs both our servers. The {PRODUCT_NAME} server and
            its database are in Helsinki, Finland. We keep the 14 most recent nightly database dumps
            (about two weeks), on the server and in an offline copy kept in step with it; since 21
            November 2026 they contain no chat messages or per-chat counts. Hetzner also takes a
            daily snapshot of the whole server and keeps each for 7 days. The elisym relay, which we
            run and which other elisym services share, is in Ashburn, Virginia, United States: it
            holds the encrypted chats until they expire, and the public listings. We may take
            occasional manual backups of the relay&apos;s data for recovery, and keep at most the
            latest one: closed stores&apos; events and expired chats leave it when it is replaced.
          </li>
          <li>
            OpenRouter and the AI hosts named in section 3: the questions and context needed for an
            answer.
          </li>
          <li>
            Stripe and its Link service (&quot;Sold through Link&quot;): the merchant of record for
            paid plans. It receives buyers&apos; payment data directly and is an independent
            controller for it, under its own privacy policy. We receive the customer and
            subscription details Stripe shares with us (section 2), never the full card number.
          </li>
          <li>
            Shopify, if you use our Shopify app: we receive your shop&apos;s data from it as
            described in section 2. Shopify is an independent controller for your shop&apos;s data,
            under its own privacy policy.
          </li>
          <li>Vercel: hosting of this website, askr.elisym.network.</li>
          <li>Google (Google Forms): our request form, and what you write in it.</li>
          <li>Zoho (Zoho Mail): the emails you send to and receive from {LEGAL_EMAIL}.</li>
        </ul>
        <p>
          Some of these providers, and our relay, are in the United States. Where data leaves the
          European Economic Area, we rely on the safeguards the GDPR provides for it, such as the
          EU-US Data Privacy Framework or the European Commission&apos;s standard contractual
          clauses, as each provider offers them.
        </p>
      </LegalSection>

      <LegalSection id="browser" title="6. Cookies and browser storage">
        <p>
          {`${PRODUCT_NAME} sets no cookies and uses no analytics, tracking or advertising, on this website, in the chat or in the admin. The chat and the admin keep a few items in your browser, only for themselves:`}
        </p>
        <ul>
          <li>
            In the chat, on the store&apos;s site: your random chat key for that store
            (localStorage, &quot;askr:v:&quot; and the Store ID), kept until you clear the
            site&apos;s data; product cards already shown, for 5 minutes (sessionStorage,
            &quot;askr:card:&quot;); and whether the chat is open (sessionStorage,
            &quot;askr:open:&quot;). sessionStorage is cleared when the tab is closed.
          </li>
          <li>
            In the admin: if you choose to remember your key, it is kept encrypted (localStorage,
            &quot;askr-admin.remembered-keys&quot;) under a key the browser makes for the admin and
            never lets out (IndexedDB, &quot;askr-admin&quot;); and the Store ID of the open tab
            (sessionStorage, &quot;askr-admin-tab-session&quot;). Sign out clears the tab&apos;s
            Store ID; Forget or Forget this device removes the remembered key; the browser&apos;s
            device key in IndexedDB stays until you clear the site&apos;s data.
          </li>
        </ul>
      </LegalSection>

      <LegalSection id="rights" title="7. Your rights">
        <p>
          Under the GDPR you can ask us for a copy of your data, to correct it, to delete it, to
          restrict or object to its use, and to receive it in a portable form. Write to <MailLink />{' '}
          or use our <ContactForm />.
        </p>
        <p>
          A merchant is identified by the Store ID: we may ask you to prove the store is yours, for
          example by signing in to the{' '}
          <ExternalLink href={ADMIN_URL} className={LEGAL_LINK_CLASS}>
            admin
          </ExternalLink>
          . A chat is linked only to a random key in your browser, not to your name, and is deleted
          within 24 hours, and gone from the server&apos;s snapshots within 7 days, so we usually
          cannot find a shopper&apos;s chat; tell us the store and the time, and we will check what
          we hold.
        </p>
        <p>
          You can also complain to the Spanish data protection authority, the Agencia Española de
          Protección de Datos (
          <ExternalLink href="https://www.aepd.es" className={LEGAL_LINK_CLASS}>
            aepd.es
          </ExternalLink>
          ), or to the authority where you live.
        </p>
      </LegalSection>

      <LegalSection id="security" title="8. Security">
        <p>
          Connections to our server and the relay are encrypted (HTTPS and secure WebSockets). Chats
          are encrypted end to end on their way through the relay. The keys we hold for stores are
          encrypted at rest. The database is not reachable from the internet.
        </p>
      </LegalSection>

      <LegalSection id="changes" title="9. Changes">
        <p>
          We update this page when what we do changes, and change the date at the top. If a change
          matters to merchants, we also tell them by email if they gave us one, and otherwise with a
          notice at the top of this page. Using {PRODUCT_NAME} is also governed by our{' '}
          <a href={TERMS_PATH} className={LEGAL_LINK_CLASS}>
            terms of service
          </a>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
