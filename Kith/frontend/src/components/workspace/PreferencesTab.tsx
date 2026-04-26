// components/workspace/PreferencesTab.tsx
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import type { WorkspaceSettings } from '@/services/workspace.service';

const preferencesSchema = z.object({
  reminder_days_before: z.string().transform(val => val.split(',').map(Number).filter(n => !isNaN(n))),
  overdue_notify_after_days: z.string().transform(val => val.split(',').map(Number).filter(n => !isNaN(n))),
  weekly_digest_enabled: z.boolean().default(true),
  due_soon_template: z.string().max(500).optional(),
  overdue_template: z.string().max(500).optional(),
  invite_template: z.string().max(500).optional(),
});

type PreferencesForm = z.infer<typeof preferencesSchema>;

interface PreferencesTabProps {
  settings: WorkspaceSettings;
  onUpdate: (payload: Partial<WorkspaceSettings>) => void;
  isUpdating: boolean;
}

export function PreferencesTab({ settings, onUpdate, isUpdating }: PreferencesTabProps) {
  const { register, handleSubmit, formState: { errors } } = useForm<PreferencesForm>({
    resolver: zodResolver(preferencesSchema),
    defaultValues: {
      reminder_days_before: settings.notification_prefs?.reminder_days_before?.join(',') || '3,1',
      overdue_notify_after_days: settings.notification_prefs?.overdue_notify_after_days?.join(',') || '3,7',
      weekly_digest_enabled: settings.notification_prefs?.weekly_digest_enabled ?? true,
      due_soon_template: settings.reminder_templates?.due_soon || '',
      overdue_template: settings.reminder_templates?.overdue || '',
      invite_template: settings.invite_message?.template || '',
    },
  });

  const onSubmit = (data: PreferencesForm) => {
    onUpdate({
      notification_prefs: {
        reminder_days_before: data.reminder_days_before,
        overdue_notify_after_days: data.overdue_notify_after_days,
        weekly_digest_enabled: data.weekly_digest_enabled,
      },
      reminder_templates: {
        due_soon: data.due_soon_template || '',
        overdue: data.overdue_template || '',
      },
      invite_message: {
        template: data.invite_template || '',
      },
    });
  };

  return (
    <Card>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {/* Notification Preferences */}
        <div>
          <h3 className="text-sm font-semibold text-text-primary mb-3">Notification Preferences</h3>
          <div className="space-y-3">
            <Input
              label="Reminder Days Before (comma-separated)"
              placeholder="3,1"
              helpText="Send reminders this many days before due date"
              {...register('reminder_days_before')}
            />
            <Input
              label="Overdue Notify After Days (comma-separated)"
              placeholder="3,7"
              helpText="Send overdue notifications this many days after due date"
              {...register('overdue_notify_after_days')}
            />
            <label className="flex items-center gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                className="w-4 h-4 accent-primary"
                {...register('weekly_digest_enabled')}
              />
              <span className="text-sm text-text-primary">Send weekly digest email</span>
            </label>
          </div>
        </div>

        {/* Reminder Templates */}
        <div className="border-t border-border pt-4">
          <h3 className="text-sm font-semibold text-text-primary mb-3">Reminder Templates</h3>
          <p className="text-xs text-text-secondary mb-3">
            Use {'{name}'}, {'{event_name}'}, {'{target_amount}'}, {'{currency}'}, {'{due_date}'} as variables
          </p>
          <div className="space-y-3">
            <Textarea
              label="Due Soon Template"
              placeholder="Hi {name}, just a reminder about your contribution for {event_name}: {target_amount} {currency} due {due_date}."
              rows={2}
              {...register('due_soon_template')}
            />
            <Textarea
              label="Overdue Template"
              placeholder="Hi {name}, your contribution for {event_name} is now overdue."
              rows={2}
              {...register('overdue_template')}
            />
          </div>
        </div>

        {/* Invite Message Template */}
        <div className="border-t border-border pt-4">
          <h3 className="text-sm font-semibold text-text-primary mb-3">Invite Message Template</h3>
          <p className="text-xs text-text-secondary mb-3">
            Use {'{invite_link}'} as a variable for the invite URL
          </p>
          <Textarea
            label="Invite Message Template"
            placeholder="Join our family on Kith: {invite_link}"
            rows={2}
            {...register('invite_template')}
          />
        </div>

        <div className="border-t border-border pt-4">
          <Button type="submit" loading={isUpdating}>
            Save Preferences
          </Button>
        </div>
      </form>
    </Card>
  );
}