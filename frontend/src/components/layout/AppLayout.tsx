import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { MobileDrawer } from './MobileDrawer';
import { Header } from './Header';
import { useDemoData } from '../../lib/DemoDataContext';
import { prefetchLeads } from '../../hooks/useData';

/** Pages dominated by a data table: they get a wider container than reading-width pages. */
const TABLE_ROUTES = ['/leads', '/businesses', '/searches'];

export function AppLayout() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { pathname } = useLocation();
  const { isDemoMode } = useDemoData();

  // Load the leads list while the person is still on the first page, so
  // clicking "Leads" doesn't have to wait for the database.
  useEffect(() => {
    if (!isDemoMode) prefetchLeads();
  }, [isDemoMode]);
  const isTablePage = TABLE_ROUTES.includes(pathname.replace(/\/+$/, ''));

  return (
    <div className="min-h-screen bg-surface-muted">
      <Sidebar />
      <MobileDrawer open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} />

      <div className="md:pl-60">
        <Header onMenuClick={() => setMobileNavOpen(true)} />
        <main
          className={`mx-auto px-4 py-6 sm:px-6 lg:px-8 ${isTablePage ? 'max-w-[100rem]' : 'max-w-6xl'}`}
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}
