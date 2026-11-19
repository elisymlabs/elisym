import { AdminIcon } from './AdminIcon';
import { AskrMark } from './AskrMark';

/** What the store's key signs, each with what it holds. Made up for the drawing. */
const SIGNED = [
  { title: 'Products', detail: '146 listings' },
  { title: 'Policies', detail: 'Returns, shipping, warranty' },
  { title: 'Settings', detail: 'Sites, language, voice' },
];

/**
 * The store as a document it holds itself: its name and Store ID, what its key has signed, and
 * who holds the key. A drawing: nothing in it is live.
 */
export function StorePassport() {
  return (
    <div className="rounded-32 sm:rounded-40 bg-surface-2 grid place-items-center px-16 py-48 sm:px-40 sm:py-72">
      <figure
        aria-label="Northwind Audio's store record: its products, policies and settings are signed with a key only the store holds."
        className="rounded-24 border-line relative w-full max-w-420 overflow-hidden border bg-white text-[#0d0d0d] shadow-[0_40px_80px_-30px_rgb(18_19_22/0.45)]"
      >
        <div aria-hidden="true">
          <div className="bg-ink text-on-ink flex items-center justify-between gap-12 px-24 py-16">
            <span className="text-11 text-on-ink-2 font-semibold tracking-[0.18em] uppercase">
              Store record
            </span>
            <AskrMark className="size-22 [--mark-ink:var(--on-ink)] [--mark-paper:var(--ink)]" />
          </div>
          <div className="flex flex-col gap-20 px-24 pt-24 pb-20">
            <div className="flex flex-col gap-6">
              <span className="text-11 font-semibold tracking-[0.14em] text-[#8f8f8f] uppercase">
                Store
              </span>
              <span className="font-serif text-[2rem] leading-none">Northwind Audio</span>
            </div>
            <div className="flex flex-col gap-6">
              <span className="text-11 font-semibold tracking-[0.14em] text-[#8f8f8f] uppercase">
                Store ID
              </span>
              <span className="text-13 font-mono text-[#5d5d5d]">npub1n7wq...4kx0p</span>
            </div>
            <ul className="flex flex-col border-t border-dashed border-[#dedede]">
              {SIGNED.map((item) => (
                <li
                  key={item.title}
                  className="flex items-center gap-12 border-b border-dashed border-[#dedede] py-12"
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-14 font-semibold">{item.title}</span>
                    <span className="text-12 truncate text-[#8f8f8f]">{item.detail}</span>
                  </span>
                  <span className="adm-badge">signed</span>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex items-center gap-12 px-24 pb-24">
            <span className="grid size-36 flex-none place-items-center rounded-full bg-[#f4f4f4]">
              <AdminIcon tab="keys" />
            </span>
            <span className="flex flex-col">
              <span className="text-13 font-semibold">Only you hold the key</span>
              <span className="text-12 text-[#8f8f8f]">Replace it through your own site</span>
            </span>
          </div>
        </div>
      </figure>
    </div>
  );
}
