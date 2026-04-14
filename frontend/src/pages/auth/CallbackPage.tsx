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
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session) { showToast.error('OAuth failed. Please try again.'); nav('/login'); return; }
      setSession(session.access_token, session.refresh_token ?? '');
      try {
        await authService.register();
        const { user, memberships } = await authService.getMe() as { user: User; memberships: Membership[] };
        setDbUser(user, memberships);
        if (!memberships || memberships.length === 0) { nav('/workspace/create'); return; }
        if (memberships.length === 1) { setActive(memberships[0].workspace_id); nav('/app/dashboard'); return; }
        nav('/workspace/select');
      } catch { showToast.error('Failed to complete sign in.'); nav('/login'); }
    });
  }, []);

  return (
    <div className="flex flex-col items-center gap-4 py-8">
      <Spinner size="lg" />
      <p className="text-sm text-text-secondary">Completing sign in…</p>
    </div>
  );
}
