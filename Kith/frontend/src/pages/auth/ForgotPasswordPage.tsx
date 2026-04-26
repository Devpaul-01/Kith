import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from 'react-router-dom';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { authService } from '@/services/auth.service';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

const schema = z.object({ email: z.string().email('Invalid email') });
type Form = z.infer<typeof schema>;

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  const { register, handleSubmit, formState: { errors } } = useForm<Form>({ resolver: zodResolver(schema) });
  const { mutate, isPending } = useMutation({
    mutationFn: (d: Form) => authService.forgotPassword(d.email),
    onSuccess: () => setSent(true),
    onError: () => setSent(true),
  });
  if (sent) return (
    <div className="text-center space-y-3">
      <h2 className="text-xl font-bold text-text-primary">Check your email</h2>
      <p className="text-sm text-text-secondary">If an account exists with that email, a password reset link has been sent.</p>
      <Link to="/login" className="block text-sm text-primary hover:underline">Back to login</Link>
    </div>
  );
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-text-primary">Reset password</h2>
        <p className="text-sm text-text-secondary mt-1">Enter your email and we'll send a reset link.</p>
      </div>
      <form onSubmit={handleSubmit(d => mutate(d))} className="space-y-4">
        <Input label="Email" type="email" placeholder="you@example.com" error={errors.email?.message} {...register('email')} />
        <Button type="submit" fullWidth loading={isPending}>Send reset link</Button>
      </form>
      <Link to="/login" className="block text-center text-sm text-primary hover:underline">Back to login</Link>
    </div>
  );
}
