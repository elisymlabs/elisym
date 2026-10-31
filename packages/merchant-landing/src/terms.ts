/**
 * The terms of service of Pay Core in the cloud, as `/terms` shows them. The
 * version is the one cloud-api records when a merchant accepts them at signup
 * (`ELISYM_CLOUD_TERMS_VERSION`): a change to the text is a new version.
 */

export const TERMS_VERSION = '2026-10-31';

export interface TermsSection {
  title: string;
  paragraphs: string[];
}

export const TERMS: TermsSection[] = [
  {
    title: 'What these terms cover',
    paragraphs: [
      'These terms apply when you run a Pay Core store in our cloud: elisym labs ("we") hosts the store node for you, and you ("the merchant") sell through it. Pay Core itself is open source (MIT): you can run the same node yourself, under no terms of ours.',
      'By creating a cloud store you accept these terms. If you act for a company, you accept them for it and confirm you may.',
    ],
  },
  {
    title: 'We never hold your money',
    paragraphs: [
      'Buyers pay straight to the wallets you sign into your payout list. We never hold or move the money of your sales, and we cannot reverse, freeze or refund a payment.',
      'A protocol fee may apply: it is a separate part of the payment that goes to the elisym treasury, shown to the buyer before they pay. Today it is zero.',
    ],
  },
  {
    title: 'Your owner key and the store key',
    paragraphs: [
      'Your owner key is your sign-in and signs your payouts. It is made in your browser and never sent to us. Keep it safe and private: we cannot recover it, and whoever holds it controls your store.',
      "Your store also has a store key, which we keep so the node can run: it signs the store's listings and its answers to buyers. It cannot change where payments go, which only your signed payout list decides. An export hands it to you.",
      'If your key is lost or exposed, contact us at once: we can withdraw the store from sale while it is sorted out.',
    ],
  },
  {
    title: 'Plans and payment',
    paragraphs: [
      'Self-serve plans are billed monthly in advance, by card or in stablecoins, at the price shown when you subscribe. Prices may change for a future period; we tell you before they do.',
      'Paid time is not refunded for a month already started. If a payment is missed, the store goes off sale after a grace period and is then stopped; its data is kept for a retention period, then deleted.',
      'Plans have limits (products, and for some plans paid orders per month) shown on the pricing page. Going over a soft limit never blocks a buyer; we may ask you to move to a plan that fits.',
    ],
  },
  {
    title: 'What you may sell',
    paragraphs: [
      'You sell only what is legal where you and your buyers are, and you are responsible for your products, prices, taxes, refunds to buyers, and support.',
      'You may not use the service for fraud, money laundering, sanctions evasion, illegal goods, content that exploits anyone, or to harm the service or other merchants.',
      'Some stores (for example, deposits credited to player or customer accounts) are reviewed before launch. We may suspend a store that breaks these terms or puts others at risk, and we tell you why when we can.',
    ],
  },
  {
    title: 'Your data',
    paragraphs: [
      'We keep what your store needs to run: its settings, products, signed payout list, and its order ledger (order and payment records, and a buyer email when you ask for one). We use it only to run, bill and support your store, and never sell it.',
      'You can export your store at any time and run it yourself. After a handover we delete our copy: at once when you confirm your own node runs it, else after a short retention period.',
    ],
  },
  {
    title: 'The service',
    paragraphs: [
      'We run your node, watch the chains for your payments and keep it updated, with care but without a guarantee of uninterrupted service. Planned maintenance is kept short. Payments made while the node is down are found when it is back.',
      'The service is provided "as is". To the extent the law allows, we are not liable for lost sales or profits, or for indirect damages, and our total liability is limited to what you paid us in the three months before the claim.',
    ],
  },
  {
    title: 'Ending',
    paragraphs: [
      'You can leave at any time: export the store, or stop paying. We can end the service with 30 days notice, or at once for a serious breach of these terms.',
    ],
  },
  {
    title: 'Changes and contact',
    paragraphs: [
      'When these terms change, the new version is posted here with its date, and you accept it to keep using the service after it applies.',
      'Questions: reach us on X at @elisymlabs.',
    ],
  },
];
