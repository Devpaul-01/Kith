import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { inviteService } from '@/services/invite.service';
import { KEYS } from '@/constants/queryKeys';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { useAuthStore } from '@/store/authStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import showToast from '@/lib/toast';
import type { Workspace, WorkspaceMember } from '@/types/models';

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const nav = useNavigate();
  const session = useAuthStore(s => s.session);
  const { setActive } = useWorkspaceStore();

  const { data, isLoading } = useQuery({ 
    queryKey: KEYS.invitePreview(token!), 
    queryFn: () => inviteService.preview(token!), 
    staleTime: 600_000 
  });
  const invite = data as { is_valid: boolean; workspace_name?: string; invited_by_name?: string } | undefined;

  const { mutate, isPending } = useMutation({
    mutationFn: () => inviteService.accept(token!),
    onSuccess: (d: unknown) => {
      const r = d as { workspace: Workspace; member: WorkspaceMember };
      setActive(r.workspace.id);
      showToast.success(`Joined ${r.workspace.name}!`);
      nav('/app/dashboard');
    },
    onError: (error: any) => {
      const status = error?.response?.status;
      if (status === 409) {
        showToast.info('You are already a member of this workspace');
        nav('/app/dashboard');
      } else {
        showToast.error('Failed to accept invite. Please try again.');
      }
    },
  });

  // ✅ Store invite token for after login
  const handleRedirectToLogin = () => {
    localStorage.setItem('pendingInviteToken', token!);
    nav('/login');
  };

  const handleRedirectToSignup = () => {
    localStorage.setItem('pendingInviteToken', token!);
    nav('/signup');
  };

  if (isLoading) return <div className="flex justify-center py-16"><Spinner size="lg" /></div>;
  if (!invite?.is_valid) return <div className="text-center py-16"><p className="text-text-secondary">This invite link is invalid or has expired.</p></div>;

  return (
    <div className="bg-white rounded-2xl border border-border p-8 mt-8 text-center space-y-4">
      <h2 className="text-2xl font-bold text-text-primary">You're invited!</h2>
      <p className="text-text-secondary"><strong>{invite.invited_by_name}</strong> invited you to join <strong>{invite.workspace_name}</strong>.</p>
      
      {session ? (
        <Button fullWidth onClick={() => mutate()} loading={isPending}>Accept Invitation</Button>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-text-secondary">You need to be logged in to accept.</p>
          <Button fullWidth onClick={handleRedirectToLogin}>Sign in to accept</Button>
          <Button variant="secondary" fullWidth onClick={handleRedirectToSignup}>Create account</Button>
        </div>
      )}
    </div>
  );
}