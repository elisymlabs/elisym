import { AdminPreview } from './components/AdminPreview';
import { AgentSetup } from './components/AgentSetup';
import { Closing } from './components/Closing';
import { Faq } from './components/Faq';
import { Features } from './components/Features';
import { Footer } from './components/Footer';
import { GetStarted } from './components/GetStarted';
import { Hero } from './components/Hero';
import { Languages } from './components/Languages';
import { Manifesto } from './components/Manifesto';
import { Pricing } from './components/Pricing';
import { SiteHeader } from './components/SiteHeader';
import { Sources } from './components/Sources';
import { Trust } from './components/Trust';
import { WorksWith } from './components/WorksWith';
import { useHashScroll } from './useHashScroll';

export function App() {
  useHashScroll();
  return (
    <div className="grain min-h-screen overflow-x-clip">
      <SiteHeader />
      <main>
        <Hero />
        <WorksWith />
        <Manifesto />
        <Features />
        <Languages />
        <Sources />
        <Trust />
        <AdminPreview />
        <GetStarted />
        <AgentSetup />
        <Pricing />
        <Faq />
        <Closing />
      </main>
      <Footer />
    </div>
  );
}
