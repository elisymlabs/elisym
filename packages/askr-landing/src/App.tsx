import { AddToCart } from './components/AddToCart';
import { Footer } from './components/Footer';
import { ForAgents } from './components/ForAgents';
import { Hero } from './components/Hero';
import { HowItWorks } from './components/HowItWorks';
import { Plans } from './components/Plans';
import { SiteHeader } from './components/SiteHeader';
import { Sources } from './components/Sources';
import { Trust } from './components/Trust';

export function App() {
  return (
    <div className="min-h-screen overflow-x-hidden">
      <SiteHeader />
      <main>
        <Hero />
        <HowItWorks />
        <Sources />
        <Trust />
        <AddToCart />
        <ForAgents />
        <Plans />
      </main>
      <Footer />
    </div>
  );
}
