import { AdminPreview } from './components/AdminPreview';
import { Closing } from './components/Closing';
import { Developers } from './components/Developers';
import { Faq } from './components/Faq';
import { Features } from './components/Features';
import { Footer } from './components/Footer';
import { ForAgents } from './components/ForAgents';
import { GetStarted } from './components/GetStarted';
import { Hero } from './components/Hero';
import { Honest } from './components/Honest';
import { Languages } from './components/Languages';
import { Manifesto } from './components/Manifesto';
import { Numbers } from './components/Numbers';
import { Pricing } from './components/Pricing';
import { SiteHeader } from './components/SiteHeader';
import { Sources } from './components/Sources';
import { Trust } from './components/Trust';
import { WorksWith } from './components/WorksWith';

export function App() {
  return (
    <div className="grain min-h-screen overflow-x-clip">
      <SiteHeader />
      <main>
        <Hero />
        <WorksWith />
        <Manifesto />
        <Features />
        <Honest />
        <Languages />
        <ForAgents />
        <Sources />
        <Trust />
        <Numbers />
        <AdminPreview />
        <GetStarted />
        <Developers />
        <Pricing />
        <Faq />
        <Closing />
      </main>
      <Footer />
    </div>
  );
}
