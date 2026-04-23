import './app.css';
import { useEffect } from 'react';
import { Toaster } from 'sonner';
import { Route, Switch, useLocation } from 'wouter';
import { ErrorBoundary } from '~/components/ErrorBoundary';
import { Footer } from '~/components/Footer';
import { Header } from '~/components/Header';
import { Providers } from '~/components/Providers';
import { TermsModal } from '~/components/TermsModal';
import AgentPage from '~/routes/Agent/Agent';
import Home from '~/routes/Home/Home';
import Profile from '~/routes/Profile/Profile';
import Terms from '~/routes/Terms/Terms';

function ScrollToTop() {
  const [location] = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location]);
  return null;
}

export function App() {
  return (
    <Providers>
      <div className="flex min-h-screen flex-col bg-bg-page font-sans text-text">
        <ScrollToTop />
        <Header />
        <ErrorBoundary>
          <main className="page-load flex-1">
            <Switch>
              <Route path="/" component={Home} />
              <Route path="/agent/:pubkey" component={AgentPage} />
              <Route path="/profile" component={Profile} />
              <Route path="/terms" component={Terms} />
              <Route>
                <div className="flex min-h-[60vh] items-center justify-center">
                  <div className="text-center">
                    <h1 className="mb-16 text-2xl font-bold">404</h1>
                    <p className="text-text-2">Page not found</p>
                  </div>
                </div>
              </Route>
            </Switch>
          </main>
        </ErrorBoundary>
        <Footer />
        <TermsModal />
        <Toaster theme="dark" position="bottom-right" duration={1500} />
      </div>
    </Providers>
  );
}
