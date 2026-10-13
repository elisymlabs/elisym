import { AdminTeaser } from './components/AdminTeaser';
import { Demo } from './components/Demo';
import { Footer } from './components/Footer';
import { Hero } from './components/Hero';
import { HowItWorks } from './components/HowItWorks';
import { SiteHeader } from './components/SiteHeader';
import { Why } from './components/Why';
import { DEMO_PRODUCT } from './constants';

export function App() {
  return (
    <div className="min-h-screen overflow-x-hidden">
      <SiteHeader />
      <main>
        <Hero />
        <Demo demo={DEMO_PRODUCT} />
        <HowItWorks />
        <Why />
        <AdminTeaser />
      </main>
      <Footer />
    </div>
  );
}
