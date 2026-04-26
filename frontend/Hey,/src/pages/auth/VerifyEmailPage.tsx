import { useLocation, Link } from 'react-router-dom';
import { MailCheck } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { authService } from '@/services/auth.service';
import { useMutation } from '@tanstack/react-query';
import showToast from '@/lib/toast';

export default function VerifyEmailPage() {
  const { state } = useLocation();
  const email = (state as { email?: string })?.email ?? 'your inbox';
  const { mutate, isPending } = useMutation({
    mutationFn: () => authService.forgotPassword(email),
    onSuccess: () => showToast.success('Verification email resent!'),
    onError: () => showToast.success('If that email is registered, a link was sent.'),
  });
  return (
    <div className="text-center space-y-4">
      <MailCheck className="mx-auto text-primary" size={48} />
      <h2 className="text-2xl font-bold text-text-primary">Check your inbox</h2>
      <p className="text-sm text-text-secondary">We sent a verification link to <strong>{email}</strong>. Click it to activate your account before logging in.</p>
      <Button variant="secondary" fullWidth onClick={() => mutate()} loading={isPending}>Resend verification email</Button>
      <Link to="/login" className="block text-sm text-primary hover:underline">Back to login</Link>
    </div>
  );
}
