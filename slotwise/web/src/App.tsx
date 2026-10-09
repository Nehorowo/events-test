import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { PageSpinner } from './components/ui';
import { useMe } from './lib/session';
import Booking from './pages/Booking';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Manage from './pages/Manage';
import Privacy from './pages/Privacy';

// The owner dashboard is split out so the public booking page stays light.
const AppLayout = lazy(() => import('./pages/app/AppLayout'));
const Agenda = lazy(() => import('./pages/app/Agenda'));
const Calendar = lazy(() => import('./pages/app/Calendar'));
const Clients = lazy(() => import('./pages/app/Clients'));
const Settings = lazy(() => import('./pages/app/Settings'));
const Onboarding = lazy(() => import('./pages/Onboarding'));
const Invite = lazy(() => import('./pages/Invite'));

function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMe();
  const location = useLocation();
  if (me.isLoading) return <PageSpinner />;
  if (!me.data?.user) {
    return <Navigate to={`/login?redirect=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  }
  return <>{children}</>;
}

function BillingRedirect() {
  const { search } = useLocation();
  return <Navigate to={`/app/settings/billing${search}`} replace />;
}

export default function App() {
  return (
    <Suspense fallback={<PageSpinner />}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="/invite/:token" element={<Invite />} />
        <Route path="/m/:token" element={<Manage />} />
        <Route path="/onboarding" element={<RequireAuth><Onboarding /></RequireAuth>} />
        <Route path="/app" element={<RequireAuth><AppLayout /></RequireAuth>}>
          <Route index element={<Agenda />} />
          <Route path="calendar" element={<Calendar />} />
          <Route path="clients" element={<Clients />} />
          <Route path="settings/:tab?" element={<Settings />} />
          <Route path="billing" element={<BillingRedirect />} />
        </Route>
        <Route path="/:slug" element={<Booking />} />
      </Routes>
    </Suspense>
  );
}
