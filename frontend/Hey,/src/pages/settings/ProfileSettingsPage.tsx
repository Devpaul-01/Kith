import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation } from '@tanstack/react-query';
import { authService } from '@/services/auth.service';
import { useAuthStore } from '@/store/authStore';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Avatar } from '@/components/ui/Avatar';
import { Card } from '@/components/ui/Card';
import { Tabs } from '@/components/ui/Tabs';
import { useFileUpload } from '@/hooks/useFileUpload';
import { ProfileContacts } from '@/components/profile/ProfileContacts';
import { ProfilePreferences } from '@/components/profile/ProfilePreferences';
import showToast from '@/lib/toast';
import type { User } from '@/types/models';
import { useRef, useState } from 'react';
import { LogOut, User as UserIcon, Bell, Phone as PhoneIcon } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

const TIMEZONES = [
  { value: 'Africa/Lagos', label: 'West Africa Time (GMT+1)' },
  { value: 'Africa/Nairobi', label: 'East Africa Time (GMT+3)' },
  { value: 'America/New_York', label: 'Eastern Time (GMT-5)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (GMT-8)' },
  { value: 'Europe/London', label: 'British Time (GMT+0)' },
  { value: 'Europe/Paris', label: 'Central European Time (GMT+1)' },
  { value: 'Asia/Dubai', label: 'Gulf Standard Time (GMT+4)' },
  { value: 'Asia/Singapore', label: 'Singapore Time (GMT+8)' },
  { value: 'Australia/Sydney', label: 'Australian Eastern Time (GMT+10)' },
];

const COUNTRIES = [
  { value: 'NG', label: 'Nigeria' },
  { value: 'US', label: 'United States' },
  { value: 'GB', label: 'United Kingdom' },
  { value: 'CA', label: 'Canada' },
  { value: 'AU', label: 'Australia' },
  { value: 'DE', label: 'Germany' },
  { value: 'FR', label: 'France' },
  { value: 'KE', label: 'Kenya' },
  { value: 'ZA', label: 'South Africa' },
  { value: 'GH', label: 'Ghana' },
];

const schema = z.object({
  full_name: z.string().min(2).max(100),
  bio: z.string().max(500).optional(),
  country_of_residence: z.string().max(100).optional(),
  timezone: z.string().optional(),
});

type Form = z.infer<typeof schema>;

export default function ProfileSettingsPage() {
  const { dbUser, setDbUser, memberships, clear } = useAuthStore();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement>(null);
  const { uploadFile, uploading } = useFileUpload();
  const [activeTab, setActiveTab] = useState<'profile' | 'contacts' | 'preferences'>('profile');

  const { register, handleSubmit, formState: { errors } } = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: {
      full_name: dbUser?.full_name || '',
      bio: dbUser?.bio || '',
      country_of_residence: dbUser?.country_of_residence || '',
      timezone: dbUser?.timezone || 'Africa/Lagos',
    },
  });

  const updateProfileMutation = useMutation({
    mutationFn: (data: Form) => authService.updateProfile(data),
    onSuccess: (data: unknown) => {
      const response = data as { user: User };
      setDbUser(response.user, memberships);
      showToast.success('Profile updated');
    },
    onError: () => showToast.error('Failed to update profile'),
  });

  const logoutMutation = useMutation({
    mutationFn: () => authService.logout(),
    onSuccess: () => {
      clear();
      navigate('/login');
    },
    onError: () => {
      clear();
      navigate('/login');
    },
  });

  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const result = await uploadFile(
      (f) => authService.getAvatarUploadUrl(f),
      (filePath) => authService.updateProfile({ avatar_url: filePath }),
      file
    );
    if (result) {
      const { user } = await authService.getMe() as { user: User };
      setDbUser(user, memberships);
      showToast.success('Avatar updated');
    }
  }

  const tabs = [
    { id: 'profile', label: 'Profile', icon: UserIcon },
    { id: 'contacts', label: 'Contacts', icon: PhoneIcon },
    { id: 'preferences', label: 'Preferences', icon: Bell },
  ];

  if (!dbUser) return null;

  return (
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-5">
      <h1 className="text-xl font-bold text-text-primary">Profile Settings</h1>

      {/* Avatar Section */}
      <Card className="space-y-4">
        <div className="flex items-center gap-4">
          <Avatar src={dbUser.avatar_url} name={dbUser.full_name} size="lg" />
          <div>
            <Button variant="secondary" size="sm" onClick={() => fileRef.current?.click()} loading={uploading}>
              Change photo
            </Button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleAvatarChange} />
            <p className="text-xs text-text-secondary mt-1">JPG, PNG — max 5MB</p>
          </div>
        </div>

        {/* Email (read-only) */}
        <div className="border-t border-border pt-4">
          <label className="text-xs font-medium text-text-secondary">Email Address</label>
          <p className="text-sm text-text-primary mt-1">{dbUser.email}</p>
          <p className="text-xs text-text-secondary mt-0.5">Email cannot be changed. Contact support if needed.</p>
        </div>
      </Card>

      {/* Tabs */}
      <Tabs
        tabs={tabs.map(t => ({ id: t.id, label: t.label }))}
        activeTab={activeTab}
        onChange={(id) => setActiveTab(id as typeof activeTab)}
      />

      {/* Profile Tab */}
      {activeTab === 'profile' && (
        <Card>
          <form onSubmit={handleSubmit((d) => updateProfileMutation.mutate(d))} className="space-y-4">
            <Input
              label="Full Name"
              placeholder="Your full name"
              error={errors.full_name?.message}
              {...register('full_name')}
            />
            <Textarea
              label="Bio"
              placeholder="Tell us about yourself..."
              rows={3}
              {...register('bio')}
            />
            <Select
              label="Country of Residence"
              options={COUNTRIES}
              placeholder="Select your country"
              {...register('country_of_residence')}
            />
            <Select
              label="Timezone"
              options={TIMEZONES}
              placeholder="Select your timezone"
              {...register('timezone')}
            />
            <Button type="submit" loading={updateProfileMutation.isPending}>
              Save Changes
            </Button>
          </form>
        </Card>
      )}

      {/* Contacts Tab */}
      {activeTab === 'contacts' && dbUser && (
        <ProfileContacts userId={dbUser.id} />
      )}

      {/* Preferences Tab */}
      {activeTab === 'preferences' && dbUser && (
        <ProfilePreferences user={dbUser} />
      )}

      {/* Danger Zone */}
      <Card>
        <h2 className="font-semibold text-text-primary mb-4">Account</h2>
        <Button variant="danger" onClick={() => logoutMutation.mutate()} loading={logoutMutation.isPending}>
          <LogOut size={16} /> Log out
        </Button>
      </Card>
    </div>
  );
}