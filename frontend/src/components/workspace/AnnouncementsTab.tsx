// components/workspace/AnnouncementsTab.tsx
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import { Megaphone } from 'lucide-react';

// Mirrors the backend announceSchema exactly
const schema = z.object({
  title: z.string().min(1, 'Title is required').max(200),
  body: z.string().min(1, 'Message is required').max(2000),
  target_role: z.enum(['admin', 'member']).optional(),
});

type Form = z.infer<typeof schema>;

interface AnnouncementsTabProps {
  onSend: (payload: Form) => void;
  isSending: boolean;
}

export function AnnouncementsTab({ onSend, isSending }: AnnouncementsTabProps) {
  const { register, handleSubmit, reset, formState: { errors } } = useForm<Form>({
    resolver: zodResolver(schema),
    defaultValues: { title: '', body: '', target_role: undefined },
  });

  return (
    <Card>
      <div className="flex items-center gap-3 mb-1">
        <Megaphone size={20} className="text-primary" />
        <h3 className="font-semibold text-text-primary">Send Announcement</h3>
      </div>
      <p className="text-sm text-text-secondary mb-4">
        Notify everyone in this workspace at once. Each recipient gets a notification with your message.
      </p>

      <form
        onSubmit={handleSubmit((d) => { onSend(d); reset(); })}
        className="space-y-4"
      >
        <Input
          label="Title"
          placeholder="e.g. Rent due this Friday"
          error={errors.title?.message}
          {...register('title')}
        />
        <Textarea
          label="Message"
          placeholder="Write your announcement..."
          rows={4}
          error={errors.body?.message}
          {...register('body')}
        />
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-text-secondary">Send to (optional)</label>
          <select
            className="text-sm border border-border rounded-xl px-3 py-2 focus:outline-none bg-white w-full"
            {...register('target_role')}
          >
            <option value="">Everyone</option>
            <option value="admin">Admins only</option>
            <option value="member">Members only</option>
          </select>
        </div>
        <Button type="submit" loading={isSending}>
          <Megaphone size={14} /> Send Announcement
        </Button>
      </form>
    </Card>
  );
}
