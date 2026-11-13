import { BUTTON } from '../buttons';
import { PRODUCT_NAME } from '../constants';
import { PHOTOS } from '../media';
import { AdminLink } from './AdminLink';
import { Reveal } from './Reveal';

export function Closing() {
  return (
    <section id="closing" className="px-12 sm:px-24">
      <div className="rounded-32 sm:rounded-40 relative isolate mx-auto flex min-h-600 max-w-1360 flex-col items-center justify-end overflow-hidden px-24 pt-160 pb-56 text-center sm:pb-80">
        <img
          src={PHOTOS.closing.src}
          alt={PHOTOS.closing.alt}
          width={PHOTOS.closing.width}
          height={PHOTOS.closing.height}
          loading="lazy"
          decoding="async"
          className="absolute inset-0 -z-20 size-full object-cover"
        />
        <div className="from-ink/85 via-ink/40 absolute inset-0 -z-10 bg-gradient-to-t to-transparent" />
        <Reveal className="flex flex-col items-center gap-24">
          <h2 className="text-48 sm:text-96 text-on-ink max-w-960 font-serif leading-[0.92]">
            Give every visitor <em>a shop assistant.</em>
          </h2>
          <p className="text-18 text-on-ink/85 max-w-560 leading-relaxed">
            {`Create your store, paste one line, and ${PRODUCT_NAME} starts answering from your catalog.`}
          </p>
          <AdminLink label="Create your store" className={BUTTON.light} />
        </Reveal>
      </div>
    </section>
  );
}
