// components/members/CreateMemberModal.tsx
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { memberService, type CreateMemberPayload } from '@/services/member.service';
import { KEYS } from '@/constants/queryKeys';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import showToast from '@/lib/toast';

const createMemberSchema = z.object({
  display_name: z.string().min(2, 'Display name is required').max(80),
  role: z.enum(['admin', 'member']).default('member'),
  is_proxy: z.boolean().default(false),
  proxy_managed_by: z.string().optional().nullable(),
  relationship_to_head: z.string().max(100).optional().nullable(),
  relationship_category: z.enum(['blood', 'marriage', 'in_law', 'friend', 'other']).optional().default('other'),
  date_of_birth: z.string().optional().nullable(),
  admin_notes: z.string().max(1000).optional().nullable(),
});

type CreateMemberForm = z.infer<typeof createMemberSchema>;

const RELATIONSHIP_CATEGORIES = [
  { value: 'blood', label: 'Blood Relative' },
  { value: 'marriage', label: 'Marriage / In-Law' },
  { value: 'in_law', label: 'In-Law' },
  { value: 'friend', label: 'Friend' },
  { value: 'other', label: 'Other' },
];

const ROLES = [
  { value: 'member', label: 'Member' },
  { value: 'admin', label: 'Admin' },
];

interface CreateMemberModalProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  admins?: Array<{ id: string; display_name: string }>;
}

export function CreateMemberModal({ open, onClose, workspaceId, admins = [] }: CreateMemberModalProps) {
  const qc = useQueryClient();
  const [isProxy, setIsProxy] = useState(false);

  const { register, handleSubmit, watch, setValue, reset, formState: { errors } } = useForm<CreateMemberForm>({
    resolver: zodResolver(createMemberSchema),
    defaultValues: {
      role: 'member',
      is_proxy: false,
      relationship_category: 'other',
    },
  });

  const watchedIsProxy = watch('is_proxy');

  const createMutation = useMutation({
    mutationFn: (payload: CreateMemberPayload) => memberService.create(workspaceId, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.members(workspaceId) });
      showToast.success('Member added successfully');
      reset();
      setIsProxy(false);
      onClose();
    },
    onError: (error: any) => {
      const message = error?.response?.data?.error?.message || 'Failed to add member';
      showToast.error(message);
    },
  });

  const onSubmit = (data: CreateMemberForm) => {
    createMutation.mutate({
      ...data,
      proxy_managed_by: data.is_proxy ? data.proxy_managed_by || null : null,
    });
  };

  const handleClose = () => {
    reset();
    setIsProxy(false);
    onClose();
  };

  return (
    <Modal open={open} onClose={handleClose} title="Add Member" size="lg">
      <div className="max-h-[calc(80vh-100px)] overflow-y-auto px-1">
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <Input
            label="Display Name *"
            placeholder="Full name"
            error={errors.display_name?.message}
            {...register('display_name')}
          />

          <Select
            label="Role"
            options={ROLES}
            error={errors.role?.message}
            {...register('role')}
          />

          {/* Proxy Member Toggle */}
          <label className="flex items-center gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              className="w-4 h-4 accent-primary"
              checked={watchedIsProxy}
              onChange={(e) => setValue('is_proxy', e.target.checked)}
            />
            <span className="text-sm text-text-primary">This is a proxy member (managed by an admin)</span>
          </label>

          {/* Proxy Managed By - only shown if is_proxy is true */}
          {watchedIsProxy && (
            <Select
              label="Managed By (Admin)"
              options={admins.map(a => ({ value: a.id, label: a.display_name }))}
              placeholder="Select an admin"
              error={errors.proxy_managed_by?.message}
              {...register('proxy_managed_by')}
            />
          )}

          {/* Relationship Fields */}
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="Relationship to Head"
              placeholder="e.g., Son, Cousin, Friend"
              {...register('relationship_to_head')}
            />
            <Select
              label="Relationship Category"
              options={RELATIONSHIP_CATEGORIES}
              {...register('relationship_category')}
            />
          </div>

          <Input
            label="Date of Birth"
            type="date"
            {...register('date_of_birth')}
          />

          {/* Admin Notes - only visible to admins (but this modal is admin-only anyway) */}
          <Textarea
            label="Admin Notes (private)"
            placeholder="Internal notes about this member..."
            rows={2}
            {...register('admin_notes')}
          />

          <div className="flex gap-3 pt-2">
            <Button variant="secondary" fullWidth type="button" onClick={handleClose}>
              Cancel
            </Button>
            <Button fullWidth type="submit" loading={createMutation.isPending}>
              Add Member
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}