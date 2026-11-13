import { AdminPreview } from './components/AdminPreview';
import { Closing } from './components/Closing';
import { Developers } from './components/Developers';
import { Faq } from './components/Faq';
import { Features } from './components/Features';
import { Footer } from './components/Footer';
import { GetStarted } from './components/GetStarted';
import { Hero } from './components/Hero';
import { Honest } from './components/Honest';
import { Languages } from './components/Languages';
import { Numbers } from './components/Numbers';
import { Pricing } from './components/Pricing';
import { SiteHeader } from './components/SiteHeader';
import { Sources } from './components/Sources';
import { Trust } from './components/Trust';

export function App() {
  return (
    <div className="min-h-screen overflow-x-hidden">
      <SiteHeader />
      <main>
        <Hero />
        <Features />
        <Honest />
        <Languages />
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
