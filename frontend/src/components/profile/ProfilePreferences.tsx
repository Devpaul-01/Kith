// components/profile/ProfilePreferences.tsx
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { authService } from '@/services/auth.service';
import { useAuthStore } from '@/store/authStore';
import { Card } from '@/components/ui/Card';
import { Select } from '@/components/ui/Select';
import showToast from '@/lib/toast';
import type { User } from '@/types/models';

const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'pt', label: 'Português' },
  { value: 'ar', label: 'العربية' },
  { value: 'hi', label: 'हिन्दी' },
  { value: 'zh', label: '中文' },
  { value: 'ja', label: '日本語' },
];

interface ProfilePreferencesProps {
  user: User;
}

export function ProfilePreferences({ user }: ProfilePreferencesProps) {
  const qc = useQueryClient();
  const { setDbUser, memberships } = useAuthStore();

  const updatePushEnabled = useMutation({
    mutationFn: (push_enabled: boolean) => authService.updateProfile({ push_enabled }),
    onSuccess: (data: any) => {
      setDbUser(data.user, memberships);
      const enabled = data.user.push_enabled;
      showToast.success(enabled ? 'Push notifications enabled' : 'Push notifications disabled');
    },
    onError: (error: any) => {
      console.error('Push toggle error:', error);
      showToast.error('Failed to update preference');
    },
  });

  const updateEmailDigest = useMutation({
    mutationFn: (email_digest_enabled: boolean) => authService.updateProfile({ email_digest_enabled }),
    onSuccess: (data: any) => {
      setDbUser(data.user, memberships);
      showToast.success(data.user.email_digest_enabled ? 'Email digest enabled' : 'Email digest disabled');
    },
    onError: (error: any) => {
      console.error('Email digest toggle error:', error);
      showToast.error('Failed to update preference');
    },
  });

  const updateLanguage = useMutation({
    mutationFn: (preferred_language: string) => authService.updateProfile({ preferred_language }),
    onSuccess: (data: any) => {
      setDbUser(data.user, memberships);
      showToast.success('Language preference updated');
    },
    onError: () => showToast.error('Failed to update language'),
  });

  return (
    <Card>
      <h2 className="font-semibold text-text-primary mb-4">Preferences</h2>
      <div className="space-y-4">
        {/* Language */}
        <div>
          <label className="text-xs font-medium text-text-secondary mb-1 block">
            Preferred Language
          </label>
          <Select
            options={LANGUAGES}
            value={user.preferred_language || 'en'}
            onChange={(e) => updateLanguage.mutate(e.target.value)}
          />
        </div>

        {/* Push Notifications Toggle */}
        <label className="flex items-center justify-between cursor-pointer select-none p-3 bg-surface-alt rounded-lg">
          <div>
            <p className="text-sm font-medium text-text-primary">Push Notifications</p>
            <p className="text-xs text-text-secondary">Receive notifications on your device</p>
          </div>
          <div className="relative inline-block w-10 h-5">
            <input
              type="checkbox"
              className="peer opacity-0 w-0 h-0"
              checked={user.push_enabled}
              onChange={(e) => updatePushEnabled.mutate(e.target.checked)}
            />
            <div className="absolute cursor-pointer top-0 left-0 right-0 bottom-0 bg-gray-300 rounded-full peer-checked:bg-primary transition-colors before:absolute before:content-[''] before:h-4 before:w-4 before:left-0.5 before:bottom-0.5 before:bg-white before:rounded-full before:transition-transform peer-checked:before:translate-x-5" />
          </div>
        </label>

        {/* Email Digest Toggle */}
        <label className="flex items-center justify-between cursor-pointer select-none p-3 bg-surface-alt rounded-lg">
          <div>
            <p className="text-sm font-medium text-text-primary">Weekly Email Digest</p>
            <p className="text-xs text-text-secondary">Receive a weekly summary of activity</p>
          </div>
          <div className="relative inline-block w-10 h-5">
            <input
              type="checkbox"
              className="peer opacity-0 w-0 h-0"
              checked={user.email_digest_enabled}
              onChange={(e) => updateEmailDigest.mutate(e.target.checked)}
            />
            <div className="absolute cursor-pointer top-0 left-0 right-0 bottom-0 bg-gray-300 rounded-full peer-checked:bg-primary transition-colors before:absolute before:content-[''] before:h-4 before:w-4 before:left-0.5 before:bottom-0.5 before:bg-white before:rounded-full before:transition-transform peer-checked:before:translate-x-5" />
          </div>
        </label>
      </div>
    </Card>
  );
        }
          
