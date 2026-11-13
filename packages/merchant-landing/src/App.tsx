import { AdminTeaser } from './components/AdminTeaser';
import { Cloud } from './components/Cloud';
import { Demo } from './components/Demo';
import { Faq } from './components/Faq';
import { FinalCta } from './components/FinalCta';
import { Footer } from './components/Footer';
import { Hero } from './components/Hero';
import { Highlights } from './components/Highlights';
import { HowItWorks } from './components/HowItWorks';
import { Pricing } from './components/Pricing';
import { SiteHeader } from './components/SiteHeader';
import { Why } from './components/Why';
import { DEMO_PRODUCT } from './constants';

export function App() {
  return (
    <div className="min-h-screen overflow-x-hidden">
      <SiteHeader />
      <main>
        <Hero />
        <Highlights />
        <Demo demo={DEMO_PRODUCT} />
        <HowItWorks />
        <Why />
        <AdminTeaser />
        <Cloud />
        <Pricing />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </div>
  );
}
