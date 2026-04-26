import { useMutation } from '@tanstack/react-query';
import { authService } from '@/services/auth.service';
import { useAuthStore } from '@/store/authStore';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import showToast from '@/lib/toast';
import { useState } from 'react';
import type { User } from '@/types/models';

export default function NotificationSettingsPage() {
  const { dbUser, setDbUser, memberships } = useAuthStore();
  const [pushEnabled, setPushEnabled] = useState(dbUser?.push_enabled ?? false);
  const [emailEnabled, setEmailEnabled] = useState(dbUser?.email_digest_enabled ?? false);
  const { mutate, isPending } = useMutation({
    mutationFn: () => authService.updateNotificationPrefs({ push_enabled: pushEnabled, email_digest_enabled: emailEnabled }),
    onSuccess: (data: unknown) => { const r = data as { preferences: { push_enabled: boolean; email_digest_enabled: boolean } }; if (dbUser) setDbUser({ ...dbUser, ...r.preferences } as User, memberships); showToast.success('Preferences saved'); },
    onError: () => showToast.error('Failed to save'),
  });
  const Toggle = ({ label, sub, checked, onChange }: { label: string; sub?: string; checked: boolean; onChange: (v: boolean) => void }) => (
    <div className="flex items-center justify-between py-3 border-b border-border last:border-0">
      <div><p className="text-sm font-medium text-text-primary">{label}</p>{sub && <p className="text-xs text-text-secondary">{sub}</p>}</div>
      <button onClick={() => onChange(!checked)} className={`relative w-11 h-6 rounded-full transition-colors ${checked ? 'bg-primary' : 'bg-slate-200'}`}>
        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-5' : ''}`} />
      </button>
    </div>
  );
  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto space-y-5">
      <h1 className="text-xl font-bold text-text-primary">Notification Settings</h1>
      <Card>
        <Toggle label="Push notifications" sub="Receive push alerts on this device" checked={pushEnabled} onChange={setPushEnabled} />
        <Toggle label="Email digest" sub="Receive a weekly summary email" checked={emailEnabled} onChange={setEmailEnabled} />
      </Card>
      <Button onClick={() => mutate()} loading={isPending}>Save preferences</Button>
    </div>
  );
}
