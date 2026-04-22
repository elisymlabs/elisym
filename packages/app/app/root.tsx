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
      <div
        className="text-text font-sans min-h-screen flex flex-col"
        style={{ background: '#fafafa' }}
      >
        <ScrollToTop />
        <Header />
        <ErrorBoundary>
          <main className="flex-1 page-load">
            <Switch>
              <Route path="/" component={Home} />
              <Route path="/agent/:pubkey" component={AgentPage} />
              <Route path="/profile" component={Profile} />
              <Route path="/terms" component={Terms} />
              <Route>
                <div className="flex items-center justify-center min-h-[60vh]">
                  <div className="text-center">
                    <h1 className="text-2xl font-bold mb-4">404</h1>
                    <p className="text-text-2">Page not found</p>
                  </div>
                </div>
              </Route>
            </Switch>
          </main>
        </ErrorBoundary>
        <Footer />
        <TermsModal />
        <Toaster
          theme="dark"
          position="bottom-right"
          duration={1500}
          toastOptions={{
            style: {
              background: 'rgba(16, 16, 18, 0.92)',
              backdropFilter: 'blur(16px)',
              WebkitBackdropFilter: 'blur(16px)',
              border: '1px solid rgba(255, 255, 255, 0.08)',
              color: 'rgba(255, 255, 255, 0.92)',
              fontSize: '13px',
              boxShadow: '0 4px 24px rgba(0,0,0,0.25), 0 1px 2px rgba(0,0,0,0.1)',
              borderRadius: '14px',
            },
          }}
        />
      </div>
    </Providers>
  );
}
