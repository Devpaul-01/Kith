import { Suspense } from 'react';
import { Outlet } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { NetworkStatusBanner } from './NetworkStatusBanner';
import { NotificationDrawer } from '@/components/notifications/NotificationDrawer';
import { Spinner } from '@/components/ui/Spinner';

export function AppLayout() {
  return (
    <div className="flex h-screen overflow-hidden bg-surface-page">
      <NetworkStatusBanner />
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <Header />
        <main className="flex-1 overflow-y-auto">
          <Suspense fallback={<div className="flex h-64 items-center justify-center"><Spinner size="lg" /></div>}>
            <Outlet />
          </Suspense>
        </main>
      </div>
      <NotificationDrawer />
      <Toaster position="top-right" toastOptions={{ style: { borderRadius: '12px', fontSize: '14px' } }} />
    </div>
  );
}