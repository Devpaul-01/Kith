import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/lib/supabase';
import { authService } from '@/services/auth.service';
import { useAuthStore } from '@/store/authStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { Spinner } from '@/components/ui/Spinner';
import showToast from '@/lib/toast';
import type { User, Membership } from '@/types/models';

export default function CallbackPage() {
  const nav = useNavigate();
  const { setSession, setDbUser } = useAuthStore();
  const { setActive } = useWorkspaceStore();

  useEffect(() => {
    async function completeSignIn() {
      // Documented flow (see docs/API_REFERENCE.md "Google OAuth"): Supabase
      // redirects back here with ?code=..., which the backend exchanges for
      // a session via POST /auth/google/callback. That call also sets the
      // httpOnly refresh_token cookie the same way email/password login
      // does, which /auth/refresh depends on — going through the backend
      // here (rather than reading the session client-side only) is what
      // keeps Google-authenticated sessions able to silently refresh.
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');

      if (code) {
        const result = await authService.googleCallback(code) as {
          access_token: string; expires_in?: number;
        };
        // authStore intentionally holds only the access token and its TTL —
        // the refresh token lives solely in the httpOnly cookie that this
        // call just set (see store/authStore.ts). Silent refresh then works
        // the same way it does for email/password logins.
        setSession(result.access_token, result.expires_in);
        return;
      }

      // Fallback for a Supabase project configured for the implicit flow,
      // where tokens arrive in the URL fragment instead of a `code` query
      // param. This path only populates frontend session state — it does
      // NOT set the backend's refresh cookie, so silent refresh will not
      // work for these sessions until googleCallback is also called here.
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('No session returned from Supabase');
      setSession(session.access_token, session.expires_in);
    }

    completeSignIn().then(async () => {
      try {
        await authService.register();
        const { user, memberships } = await authService.getMe() as { user: User; memberships: Membership[] };
        setDbUser(user, memberships);
        if (!memberships || memberships.length === 0) { nav('/workspace/create'); return; }
        if (memberships.length === 1) { setActive(memberships[0].workspace_id); nav('/app/dashboard'); return; }
        nav('/workspace/select');
      } catch { showToast.error('Failed to complete sign in.'); nav('/login'); }
    }).catch(() => {
      showToast.error('OAuth failed. Please try again.');
      nav('/login');
    });
  }, []);

  return (
    <div className="flex flex-col items-center gap-4 py-8">
      <Spinner size="lg" />
      <p className="text-sm text-text-secondary">Completing sign in…</p>
    </div>
  );
}
