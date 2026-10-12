// components/profile/AccountSecurity.tsx
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { authService } from '@/services/auth.service';
import { useAuthStore } from '@/store/authStore';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { PasswordInput } from '@/components/ui/PasswordInput';
import showToast from '@/lib/toast';
import { getErrorMessage } from '@/utils/errors';

// Mirrors the backend changePasswordSchema exactly
const schema = z.object({
  current_password: z.string().min(1, 'Current password is required'),
  new_password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(72, 'Password too long')
    .regex(/[A-Z]/, 'Must contain at least one uppercase letter')
    .regex(/[0-9]/, 'Must contain at least one number'),
});

type Form = z.infer<typeof schema>;

export function AccountSecurity() {
  const navigate = useNavigate();
  const { clear } = useAuthStore();

  const { register, handleSubmit, reset, watch, formState: { errors } } = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: { current_password: '', new_password: '' },
  });

  const changePasswordMutation = useMutation({
    mutationFn: (data: Form) => authService.changePassword(data),
    onSuccess: () => {
      showToast.success('Password updated');
      reset();
    },
    onError: (error: unknown) => showToast.error(getErrorMessage(error)),
  });

  const logoutAllMutation = useMutation({
    mutationFn: () => authService.logoutAllDevices(),
    onSuccess: () => {
      clear();
      navigate('/login');
      showToast.success('Logged out of all devices');
    },
    onError: (error: unknown) => showToast.error(getErrorMessage(error)),
  });

  const dataExportMutation = useMutation({
    mutationFn: () => authService.requestDataExport(),
    onSuccess: () => showToast.success("We're preparing your data export — you'll get an email when it's ready."),
    onError: (error: unknown) => showToast.error(getErrorMessage(error)),
  });

  return (
    <div className="space-y-5">
      <Card>
        <h2 className="font-semibold text-text-primary mb-4">Change Password</h2>
        <form
          onSubmit={handleSubmit((d) => changePasswordMutation.mutate(d))}
          className="space-y-4"
        >
          <PasswordInput
            label="Current Password"
            autoComplete="current-password"
            error={errors.current_password?.message}
            {...register('current_password')}
          />
          <PasswordInput
            label="New Password"
            autoComplete="new-password"
            showStrength
            value={watch('new_password')}
            error={errors.new_password?.message}
            {...register('new_password')}
          />
          <Button type="submit" loading={changePasswordMutation.isPending}>
            Update Password
          </Button>
        </form>
      </Card>

      <Card>
        <h2 className="font-semibold text-text-primary mb-1">Your Data</h2>
        <p className="text-xs text-text-secondary mb-3">
          Download a copy of your contributions and task history across every family or group you're part of.
        </p>
        <Button
          variant="secondary"
          onClick={() => dataExportMutation.mutate()}
          loading={dataExportMutation.isPending}
        >
          Download my data
        </Button>
      </Card>

      <Card>
        <h2 className="font-semibold text-text-primary mb-1">Active Sessions</h2>
        <p className="text-xs text-text-secondary mb-3">
          If you think your account may be compromised, sign out everywhere — including this device.
        </p>
        <Button
          variant="danger"
          onClick={() => {
            if (confirm('Log out of all devices, including this one?')) logoutAllMutation.mutate();
          }}
          loading={logoutAllMutation.isPending}
        >
          Log out of all devices
        </Button>
      </Card>
    </div>
  );
}
