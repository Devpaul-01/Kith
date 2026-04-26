import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate } from 'react-router-dom';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { authService } from '@/services/auth.service';
import { useAuthStore } from '@/store/authStore';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { useMutation } from '@tanstack/react-query';
import showToast from '@/lib/toast';
import type { User, Membership } from '@/types/models';

const schema = z.object({ full_name: z.string().min(2).max(100), country_of_residence: z.string().min(2).max(100) });
type Form = z.infer<typeof schema>;

export default function RegisterPage() {
  const nav = useNavigate();
  const { setDbUser } = useAuthStore();
  const { setActive } = useWorkspaceStore();
  const { register, handleSubmit, formState: { errors } } = useForm<Form>({ resolver: zodResolver(schema) });
  const { mutate, isPending } = useMutation({
    mutationFn: (d: Form) => authService.register(d),
    onSuccess: async () => {
      const { user, memberships } = await authService.getMe() as { user: User; memberships: Membership[] };
      setDbUser(user, memberships);
      if (memberships.length === 0) nav('/workspace/create');
      else if (memberships.length === 1) { setActive(memberships[0].workspace_id); nav('/app/dashboard'); }
      else nav('/workspace/select');
    },
    onError: () => showToast.error('Failed to complete registration.'),
  });
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-text-primary">Complete your profile</h2>
        <p className="text-sm text-text-secondary mt-1">Just a couple more details.</p>
      </div>
      <form onSubmit={handleSubmit(d => mutate(d))} className="space-y-4">
        <Input label="Full name" placeholder="Jane Smith" error={errors.full_name?.message} {...register('full_name')} />
        <Input label="Country" placeholder="Nigeria" error={errors.country_of_residence?.message} {...register('country_of_residence')} />
        <Button type="submit" fullWidth loading={isPending}>Continue</Button>
      </form>
    </div>
  );
}
