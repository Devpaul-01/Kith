import { useEffect, useState } from 'react';
import { RouterProvider } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { router } from '@/router';
import { queryClient } from '@/lib/queryClient';
import { useAuthStore } from '@/store/authStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { authService } from '@/services/auth.service';
import type { User, Membership } from '@/types/models';

function removeSplash(cb: () => void) {
  const splash = document.getElementById('splash');
  if (splash) {
    splash.style.opacity = '0';
    splash.style.transition = 'opacity 0.3s ease';
    setTimeout(() => { splash.remove(); cb(); }, 350);
  } else {
    cb();
  }
}

function AppBootstrap() {
  const [ready, setReady] = useState(false);
  const { session, setDbUser, clear } = useAuthStore();
  const { activeWorkspaceId, setActive } = useWorkspaceStore();

  useEffect(() => {
    let done = false;

    function finish() {
      if (done) return;
      done = true;
      removeSplash(() => setReady(true));
    }

    // SAFETY NET — force splash off after 3 seconds no matter what
    const hardTimeout = setTimeout(() => {
      console.warn('[Kith] Boot timed out — forcing splash removal');
      finish();
    }, 3000);

    async function boot() {
      try {
        if (session?.access_token) {
          const result = await authService.getMe() as {
            user: User;
            memberships: Membership[];
          };
          if (result?.user) {
            setDbUser(result.user, result.memberships ?? []);
            if (!activeWorkspaceId && result.memberships?.length === 1) {
              setActive(result.memberships[0].workspace_id);
            }
          }
        }
      } catch (err) {
        console.error('[Kith] Boot error:', err);
        clear();
      } finally {
        clearTimeout(hardTimeout);
        finish();
      }
    }

    boot();

    return () => clearTimeout(hardTimeout);
  }, []);

  if (!ready) return null;
  return <RouterProvider router={router} />;
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppBootstrap />
      <ReactQueryDevtools initialIsOpen={false} />
    </QueryClientProvider>
  );
}