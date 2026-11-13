import { PRODUCT_NAME } from '../constants';
import { AdminLink } from './AdminLink';
import { Visual } from './Visual';

export function Closing() {
  return (
    <section id="closing" className="mx-auto max-w-1200 px-16 pb-80 sm:px-24 sm:pb-112">
      <div className="rounded-32 border-line-2 relative isolate flex min-h-420 flex-col items-center justify-center gap-24 overflow-hidden border px-24 py-64 text-center">
        <Visual name="closing" className="absolute inset-0 -z-20 size-full" />
        <div aria-hidden="true" className="bg-bg/70 absolute inset-0 -z-10" />
        <h2 className="text-32 sm:text-48 max-w-720 leading-[1.1] font-semibold tracking-tight">
          Give every visitor a shop assistant
        </h2>
        <p className="text-16 sm:text-18 text-text-2 max-w-560 leading-relaxed">
          {`Create your store, paste one line, and ${PRODUCT_NAME} starts answering from your catalog.`}
        </p>
        <AdminLink
          label="Create your store"
          className="rounded-12 bg-accent text-15 text-accent-text px-24 py-14 font-semibold transition hover:brightness-95"
        />
      </div>
    </section>
  );
}
