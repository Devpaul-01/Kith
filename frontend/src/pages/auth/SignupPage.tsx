// pages/auth/SignupPage.tsx
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Input } from '@/components/ui/Input';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { Button } from '@/components/ui/Button';
import { authService } from '@/services/auth.service';
import { useAuthStore } from '@/store/authStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import showToast from '@/lib/toast';
import { getErrorMessage } from '@/utils/errors';
import { useMutation } from '@tanstack/react-query';
import type { User, Membership } from '@/types/models';

// Mirrors the backend signupSchema exactly
const schema = z.object({
  full_name:            z.string().min(2, 'Name must be at least 2 characters').max(100),
  email:                z.string().email('Enter a valid email address'),
  password:             z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(72)
    .regex(/[A-Z]/, 'Must contain at least one uppercase letter')
    .regex(/[0-9]/, 'Must contain at least one number'),
  country_of_residence: z.string().min(2, 'Country is required').max(100),
});

type Form = z.infer<typeof schema>;

// Common countries sorted by diaspora relevance (matches backend SUPPORTED_CURRENCIES list)
const COUNTRIES = [
  'Nigeria', 'Ghana', 'Kenya', 'United Kingdom', 'United States', 'Canada',
  'South Africa', 'Zimbabwe', 'Uganda', 'Tanzania', 'Ethiopia', 'Cameroon',
  'Senegal', 'Côte d\'Ivoire', 'India', 'Pakistan', 'Bangladesh',
  'Jamaica', 'Trinidad and Tobago', 'Barbados', 'Other',
];

export default function SignupPage() {
  const nav            = useNavigate();
  const [params]       = useSearchParams();
  const inviteToken    = params.get('invite');          // from /auth/signup?invite=TOKEN
  const intent         = params.get('intent');          // 'event' | 'recurring'

  const { setSession, setDbUser } = useAuthStore();
  const { setActive }             = useWorkspaceStore();

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<Form>({ resolver: zodResolver(schema) });

  const pw = watch('password', '');

  // Email/Password signup
  const { mutate, isPending } = useMutation({
    mutationFn: (d: Form) => authService.signup(d),

    onSuccess: async (response: any, variables: Form) => {
      if (response.access_token) {
        setSession(response.access_token, response.refresh_token, response.expires_in);

        try {
          const { user, memberships } = await authService.getMe() as {
            user: User;
            memberships: Membership[];
          };
          setDbUser(user, memberships ?? []);
          showToast.success('Account created!');
          redirectAfterAuth(memberships ?? []);
        } catch (err: unknown) {
          console.error('getMe failed:', err);
          showToast.error('Account created but failed to load profile. Please log in.');
          nav('/login');
        }
        return;
      }

      nav('/signup/verify-email', { state: { email: variables.email } });
    },

    onError: (e: unknown) => {
      showToast.error(getErrorMessage(e));
    },
  });

  // Google OAuth signup
  const googleMutation = useMutation({
    mutationFn: () => authService.getGoogleUrl(`${window.location.origin}/auth/callback`),
    onSuccess: (d: unknown) => {
      window.location.href = (d as { url: string }).url;
    },
    onError: (e: unknown) => showToast.error(getErrorMessage(e)),
  });

  function redirectAfterAuth(memberships: Membership[]) {
    const pendingInviteToken = localStorage.getItem('pendingInviteToken');
    
    if (pendingInviteToken) {
      localStorage.removeItem('pendingInviteToken');
      nav(`/invite/${pendingInviteToken}`);
      return;
    }
    
    if (inviteToken) {
      nav(`/invite/${inviteToken}`);
      return;
    }
    
    if (memberships.length > 0) {
      if (memberships.length === 1) {
        setActive(memberships[0].workspace_id);
        nav('/app/dashboard');
        return;
      }
      nav('/workspace/select');
      return;
    }
    
    nav(intent ? `/workspace/create?intent=${intent}` : '/workspace/create');
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold text-text-primary">Create your account</h2>
        <p className="text-sm text-text-secondary mt-1">
          Start coordinating your family finances — free to get started.
        </p>
      </div>

      {/* Invite context banner */}
      {inviteToken && (
        <div className="rounded-lg bg-primary/10 border border-primary/20 px-4 py-3 text-sm text-primary font-medium">
          You were invited to join a family workspace. Create your account to continue.
        </div>
      )}

      {/* Email Signup Form */}
      <form onSubmit={handleSubmit((d) => mutate(d))} className="space-y-4">
        <Input
          label="Full name"
          placeholder="Jane Smith"
          autoComplete="name"
          error={errors.full_name?.message}
          {...register('full_name')}
        />

        <Input
          label="Email address"
          type="email"
          placeholder="you@example.com"
          autoComplete="email"
          error={errors.email?.message}
          {...register('email')}
        />

        <PasswordInput
          label="Password"
          placeholder="At least 8 characters"
          autoComplete="new-password"
          showStrength
          value={pw}
          error={errors.password?.message}
          {...register('password')}
        />

        {/* Country dropdown */}
        <div className="space-y-1">
          <label className="block text-sm font-medium text-text-primary">
            Country of residence
          </label>
          <select
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
            defaultValue=""
            {...register('country_of_residence')}
          >
            <option value="" disabled>Select your country</option>
            {COUNTRIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          {errors.country_of_residence && (
            <p className="text-xs text-error">{errors.country_of_residence.message}</p>
          )}
        </div>

        <Button type="submit" fullWidth loading={isPending}>
          Create account
        </Button>
      </form>

      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <div className="w-full border-t border-border" />
        </div>
        <div className="relative flex justify-center text-xs text-text-secondary">
          <span className="bg-white px-3">or</span>
        </div>
      </div>

      {/* Google Signup Button */}
      <Button 
        variant="secondary" 
        fullWidth 
        onClick={() => googleMutation.mutate()} 
        loading={googleMutation.isPending}
        className="flex items-center justify-center gap-2"
      >
        <svg className="w-5 h-5" viewBox="0 0 24 24">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
        </svg>
        Continue with Google
      </Button>

      {/* Sign in link */}
      <p className="text-center text-sm text-text-secondary">
        Already have an account?{' '}
        <Link to="/login" className="text-primary font-semibold hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}