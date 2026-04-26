import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { supabase } from '@/lib/supabase';
import { authService } from '@/services/auth.service';
import { useAuthStore } from '@/store/authStore';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { Button } from '@/components/ui/Button';
import { useMutation } from '@tanstack/react-query';
import showToast from '@/lib/toast';
import { Spinner } from '@/components/ui/Spinner';

const schema = z.object({
  password: z.string().min(8).regex(/[A-Z]/).regex(/[0-9]/).max(72),
  confirm: z.string(),
}).refine(d => d.password === d.confirm, { message: "Passwords don't match", path: ['confirm'] });
type Form = z.infer<typeof schema>;

export default function ResetPasswordPage() {
  const nav = useNavigate();
  const { setSession } = useAuthStore();
  const [ready, setReady] = useState(false);
  const { register, handleSubmit, watch, formState: { errors } } = useForm<Form>({ resolver: zodResolver(schema) });
  const pw = watch('password', '');

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session?.access_token) { setSession(session.access_token, session.refresh_token ?? ''); setReady(true); }
      else { showToast.error('Invalid or expired reset link.'); nav('/login'); }
    });
  }, []);

  const { mutate, isPending } = useMutation({
    mutationFn: (d: Form) => authService.resetPassword(d.password),
    onSuccess: () => { showToast.success('Password updated! Please log in.'); nav('/login'); },
    onError: () => showToast.error('Failed to reset password. The link may have expired.'),
  });

  if (!ready) return <div className="flex justify-center py-8"><Spinner /></div>;
  return (
    <div className="space-y-5">
      <h2 className="text-2xl font-bold text-text-primary">Set new password</h2>
      <form onSubmit={handleSubmit(d => mutate(d))} className="space-y-4">
        <PasswordInput label="New password" placeholder="••••••••" showStrength value={pw} error={errors.password?.message} {...register('password')} />
        <PasswordInput label="Confirm password" placeholder="••••••••" error={errors.confirm?.message} {...register('confirm')} />
        <Button type="submit" fullWidth loading={isPending}>Update password</Button>
      </form>
    </div>
  );
}
