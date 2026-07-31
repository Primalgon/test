import { lazy, Suspense } from 'react';
import { Routes, Route } from 'react-router';
import { SiteHeader } from './components/SiteHeader';
import { SiteFooter } from './components/SiteFooter';
import Home from './pages/Home';

/**
 * Route-level code splitting. Only Home is in the initial bundle; every other
 * page is fetched on navigation. One Route per entry in brief.site.pages —
 * the streaming_service preset requires the account surface, so login,
 * signup and account are not optional here.
 */
const Signup = lazy(() => import('./pages/Signup'));
const Login = lazy(() => import('./pages/Login'));
const Account = lazy(() => import('./pages/Account'));
const Contact = lazy(() => import('./pages/Contact'));
const NotFound = lazy(() => import('./pages/NotFound'));

export default function App() {
  return (
    <>
      <SiteHeader />
      <main id="main">
        <Suspense fallback={<div className="shell section" aria-busy="true" />}>
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/signup" element={<Signup />} />
            <Route path="/login" element={<Login />} />
            <Route path="/account" element={<Account />} />
            <Route path="/contact" element={<Contact />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </main>
      <SiteFooter />
    </>
  );
}
