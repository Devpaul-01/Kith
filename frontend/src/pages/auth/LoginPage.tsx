import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Input } from '@/components/ui/Input';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { Button } from '@/components/ui/Button';
import { useAuthStore } from '@/store/authStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import showToast from '@/lib/toast';
import { getErrorMessage } from '@/utils/errors';
import { useMutation } from '@tanstack/react-query';
import { useState, useEffect } from 'react';
import type { ApiError } from '@/types/api';
import type { User, Membership } from '@/types/models';
import { authService } from '@/services/auth.service';

const schema = z.object({ email: z.string().email('Invalid email'), password: z.string().min(1, 'Required') });
type Form = z.infer<typeof schema>;

export default function LoginPage() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [showVerifyBanner, setShowVerifyBanner] = useState(false);
  const { setSession, setDbUser } = useAuthStore();
  const { setActive } = useWorkspaceStore();
  const { register, handleSubmit, formState: { errors } } = useForm<Form>({ resolver: zodResolver(schema) });

  useEffect(() => {
    if (params.get('reason') === 'session_expired') showToast.error('Your session expired. Please log in again.');
  }, []);

  const { mutate, isPending } = useMutation({
    mutationFn: (d: Form) => authService.login(d),
    onSuccess: (data: unknown) => {
      const d = data as { access_token: string; expires_in: number; user: User | null; memberships: Membership[] };
      setSession(d.access_token, d.expires_in);
      setDbUser(d.user, d.memberships);

      const pendingInviteToken = localStorage.getItem('pendingInviteToken');
      if (pendingInviteToken) {
        localStorage.removeItem('pendingInviteToken');
        nav(`/invite/${pendingInviteToken}`);
      }

      if (!d.user) {
        showToast.error('Unable to load profile. Please contact support.');
        return;
      }
      if (d.memberships.length === 0) { nav('/workspace/create'); return; }
      if (d.memberships.length === 1) { setActive(d.memberships[0].workspace_id); nav('/app/dashboard'); return; }
      nav('/workspace/select');
    },
    onError: (e: unknown) => {
      const err = e as ApiError;
      if (err.status === 422 && err.message.toLowerCase().includes('verify')) { setShowVerifyBanner(true); return; }
      showToast.error(getErrorMessage(e));
    },
  });

  const googleMutation = useMutation({
    mutationFn: () => authService.getGoogleUrl(`${window.location.origin}/auth/callback`),
    onSuccess: (d: unknown) => { window.location.href = (d as { url: string }).url; },
    onError: (e: unknown) => showToast.error(getErrorMessage(e)),
  });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-text-primary">Welcome back</h2>
        <p className="text-sm text-text-secondary mt-1">Sign in to your account</p>
      </div>
      {showVerifyBanner && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-3 text-sm text-yellow-800">
          Please verify your email before logging in.{' '}
          <Link to="/signup/verify-email" className="font-semibold underline">Resend link</Link>
        </div>
      )}
      <form onSubmit={handleSubmit(d => mutate(d))} className="space-y-4">
        <Input label="Email" type="email" placeholder="you@example.com" error={errors.email?.message} {...register('email')} />
        <PasswordInput label="Password" placeholder="••••••••" error={errors.password?.message} {...register('password')} />
        <div className="text-right">
          <Link to="/auth/forgot-password" className="text-xs text-primary hover:underline">Forgot password?</Link>
        </div>
        <Button type="submit" fullWidth loading={isPending}>Sign in</Button>
      </form>
      <div className="relative">
        <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-border" /></div>
        <div className="relative flex justify-center text-xs text-text-secondary"><span className="bg-white px-3">or</span></div>
      </div>
      <Button variant="secondary" fullWidth onClick={() => googleMutation.mutate()} loading={googleMutation.isPending}>
        Continue with Google
      </Button>
      <p className="text-center text-sm text-text-secondary">
        Don't have an account?{' '}<Link to="/signup" className="text-primary font-semibold hover:underline">Sign up</Link>
      </p>
    </div>
  );
}
