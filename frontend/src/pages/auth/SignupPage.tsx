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

  const { mutate, isPending } = useMutation({
    mutationFn: (d: Form) => authService.signup(d),

    onSuccess: async (response: any, variables: Form) => {
      // ── Confirmation OFF (testing) ─────────────────────────────
      // Backend returns tokens immediately → log them straight in
      if (response.access_token) {
        setSession(response.access_token, response.refresh_token, response.expires_in);

        try {
          // Fetch the full profile + memberships so the store is complete
          const { user, memberships } = await authService.getMe() as {
            user: User;
            memberships: Membership[];
          };
          setDbUser(user, memberships ?? []);
          showToast.success('Account created!');
          redirectAfterAuth(memberships ?? []);
        } catch (err: unknown) {
  console.error('getMe failed:', err); // check status code + message
  showToast.error('Account created but failed to load profile. Please log in.');
  nav('/login');
}
          
          // Profile fetch failed — send to login so they can retry
          
        return;
      }

      // ── Confirmation ON (production) ───────────────────────────
      // No tokens yet — user needs to verify email first
      nav('/signup/verify-email', { state: { email: variables.email } });
    },

    onError: (e: unknown) => {
      showToast.error(getErrorMessage(e));
    },
  });

  function redirectAfterAuth(memberships: Membership[]) {
    // If they arrived via an invite link, accept it first
    if (inviteToken) {
      nav(`/invite/${inviteToken}`);
      return;
    }
    if (memberships.length === 0) {
      // Brand new user — send to workspace creation
      // Pass intent so the container creation step is pre-selected
      nav(intent ? `/workspace/create?intent=${intent}` : '/workspace/create');
      return;
    }
    if (memberships.length === 1) {
      setActive(memberships[0].workspace_id);
      nav('/app/dashboard');
      return;
    }
    nav('/workspace/select');
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

      {/* Form */}
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

        {/* Country — dropdown instead of free text to avoid typos */}
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
