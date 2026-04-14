import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { authService } from '@/services/auth.service';
import { useAuthStore } from '@/store/authStore';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import { Avatar } from '@/components/ui/Avatar';
import { Card } from '@/components/ui/Card';
import { useFileUpload } from '@/hooks/useFileUpload';
import showToast from '@/lib/toast';
import type { User } from '@/types/models';
import { useRef } from 'react';
import { LogOut } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

const schema = z.object({ full_name: z.string().min(2).max(100), bio: z.string().max(500).optional(), country_of_residence: z.string().max(100).optional(), timezone: z.string().optional() });
type Form = z.infer<typeof schema>;

export default function ProfileSettingsPage() {
  const { dbUser, setDbUser, memberships, clear } = useAuthStore();
  const nav = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const { uploadFile, uploading } = useFileUpload();
  const { register, handleSubmit, formState: { errors } } = useForm<Form>({ resolver: zodResolver(schema), defaultValues: { full_name: dbUser?.full_name, bio: dbUser?.bio, country_of_residence: dbUser?.country_of_residence, timezone: dbUser?.timezone } });
  const { mutate, isPending } = useMutation({
    mutationFn: (d: Form) => authService.updateProfile(d),
    onSuccess: (data: unknown) => { const r = data as { user: User }; setDbUser(r.user, memberships); showToast.success('Profile updated'); },
    onError: () => showToast.error('Failed to update profile'),
  });
  const logoutMutation = useMutation({ mutationFn: () => authService.logout(), onSuccess: () => { clear(); nav('/login'); }, onError: () => { clear(); nav('/login'); } });
  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return;
    const result = await uploadFile((f) => authService.getAvatarUploadUrl(f), (fp) => authService.updateProfile({ avatar_url: fp }), file);
    if (result) { const { user } = await authService.getMe() as { user: User }; setDbUser(user, memberships); showToast.success('Avatar updated'); }
  }
  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto space-y-5">
      <h1 className="text-xl font-bold text-text-primary">Profile Settings</h1>
      <Card className="space-y-4">
        <div className="flex items-center gap-4">
          <Avatar src={dbUser?.avatar_url} name={dbUser?.full_name} size="lg" />
          <div><Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()} loading={uploading}>Change photo</Button><input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleAvatarChange} /><p className="text-xs text-text-secondary mt-1">JPG, PNG — max 5MB</p></div>
        </div>
        <form onSubmit={handleSubmit(d => mutate(d))} className="space-y-4">
          <Input label="Full name" error={errors.full_name?.message} {...register('full_name')} />
          <Textarea label="Bio" placeholder="Tell us about yourself..." rows={3} {...register('bio')} />
          <Input label="Country" placeholder="Nigeria" {...register('country_of_residence')} />
          <Input label="Timezone" placeholder="Africa/Lagos" {...register('timezone')} />
          <Button type="submit" loading={isPending}>Save changes</Button>
        </form>
      </Card>
      <Card><h2 className="font-semibold text-text-primary mb-4">Account</h2><Button variant="danger" onClick={() => logoutMutation.mutate()} loading={logoutMutation.isPending}><LogOut size={16} />Log out</Button></Card>
    </div>
  );
}
