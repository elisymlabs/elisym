import { PRODUCT_NAME } from '../constants';
import { TERMS, TERMS_VERSION } from '../terms';
import { Logo } from './Logo';

/** The cloud terms of service, on their own page of the landing. */
export function TermsPage() {
  return (
    <div className="min-h-screen overflow-x-hidden">
      <header className="border-line/60 bg-bg/80 sticky top-0 z-20 border-b backdrop-blur-md">
        <div className="mx-auto flex h-64 max-w-1160 items-center justify-between gap-16 px-16 sm:px-24">
          <Logo />
          <a
            href="/"
            className="text-14 text-text-2 hover:text-text rounded-8 px-12 py-8 whitespace-nowrap"
          >
            {`Back to ${PRODUCT_NAME}`}
          </a>
        </div>
      </header>
      <main className="mx-auto flex max-w-720 flex-col gap-32 px-16 py-56 sm:px-24 sm:py-80">
        <div className="flex flex-col gap-8">
          <p className="text-13 text-accent-ink font-semibold tracking-wide uppercase">Terms</p>
          <h1 className="text-32 sm:text-40 font-semibold tracking-tight">{`${PRODUCT_NAME} in the cloud: terms of service`}</h1>
          <p className="text-14 text-text-3">Version {TERMS_VERSION}</p>
        </div>
        {TERMS.map((section) => (
          <section key={section.title} className="flex flex-col gap-10">
            <h2 className="text-20 font-semibold">{section.title}</h2>
            {section.paragraphs.map((paragraph) => (
              <p key={paragraph} className="text-15 text-text-2 leading-relaxed">
                {paragraph}
              </p>
            ))}
          </section>
        ))}
      </main>
      <footer className="border-line border-t">
        <p className="text-13 text-text-3 mx-auto max-w-720 px-16 py-20 sm:px-24">
          {`© ${new Date().getFullYear()} elisym labs`}
        </p>
      </footer>
    </div>
  );
}
