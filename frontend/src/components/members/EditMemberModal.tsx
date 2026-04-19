// components/members/EditMemberModal.tsx
import { useState, useEffect } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { memberService, type UpdateMemberPayload } from '@/services/member.service';
import { KEYS } from '@/constants/queryKeys';
import { Modal } from '@/components/ui/Modal';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { Button } from '@/components/ui/Button';
import showToast from '@/lib/toast';
import type { WorkspaceMember } from '@/types/models';

const editMemberSchema = z.object({
  display_name: z.string().min(2, 'Display name is required').max(80).optional(),
  role: z.enum(['admin', 'member']).optional(),
  is_proxy: z.boolean().optional(),
  proxy_managed_by: z.string().optional().nullable(),
  is_active: z.boolean().optional(),
  relationship_to_head: z.string().max(100).optional().nullable(),
  relationship_category: z.enum(['blood', 'marriage', 'in_law', 'friend', 'other']).optional(),
  date_of_birth: z.string().optional().nullable(),
  admin_notes: z.string().max(1000).optional().nullable(),
  version: z.string().optional(),
});

type EditMemberForm = z.infer<typeof editMemberSchema>;

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

const ACTIVE_OPTIONS = [
  { value: 'true', label: 'Active' },
  { value: 'false', label: 'Inactive' },
];

interface EditMemberModalProps {
  open: boolean;
  onClose: () => void;
  member: WorkspaceMember;
  workspaceId: string;
  isSelf: boolean;
  admins?: Array<{ id: string; display_name: string }>;
  onSuccess?: () => void;
}

export function EditMemberModal({ open, onClose, member, workspaceId, isSelf, admins = [], onSuccess }: EditMemberModalProps) {
  const qc = useQueryClient();
  const [isProxy, setIsProxy] = useState(member.is_proxy);

  const { register, handleSubmit, watch, setValue, reset, formState: { errors } } = useForm<EditMemberForm>({
    resolver: zodResolver(editMemberSchema),
    defaultValues: {
      display_name: member.display_name,
      role: member.role,
      is_proxy: member.is_proxy,
      proxy_managed_by: (member as any).proxy_managed_by || null,
      is_active: member.is_active,
      relationship_to_head: (member as any).relationship_to_head || null,
      relationship_category: (member as any).relationship_category || 'other',
      date_of_birth: (member as any).date_of_birth || null,
      admin_notes: (member as any).admin_notes || null,
      version: member.updated_at,
    },
  });

  const watchedIsProxy = watch('is_proxy');

  useEffect(() => {
    if (open) {
      reset({
        display_name: member.display_name,
        role: member.role,
        is_proxy: member.is_proxy,
        proxy_managed_by: (member as any).proxy_managed_by || null,
        is_active: member.is_active,
        relationship_to_head: (member as any).relationship_to_head || null,
        relationship_category: (member as any).relationship_category || 'other',
        date_of_birth: (member as any).date_of_birth || null,
        admin_notes: (member as any).admin_notes || null,
        version: member.updated_at,
      });
      setIsProxy(member.is_proxy);
    }
  }, [open, member]);

  const updateMutation = useMutation({
    mutationFn: (payload: UpdateMemberPayload) => memberService.update(workspaceId, member.id, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.members(workspaceId) });
      qc.invalidateQueries({ queryKey: KEYS.member(workspaceId, member.id) });
      showToast.success('Member updated successfully');
      onSuccess?.();
      onClose();
    },
    onError: (error: any) => {
      const message = error?.response?.data?.error?.message || 'Failed to update member';
      showToast.error(message);
    },
  });

  const onSubmit = (data: EditMemberForm) => {
    const payload: UpdateMemberPayload = {
      ...data,
      proxy_managed_by: data.is_proxy ? data.proxy_managed_by || null : null,
      version: member.updated_at,
    };
    updateMutation.mutate(payload);
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  // Determine if user can edit role (can't demote self if last admin)
  const canEditRole = !isSelf || (member.role === 'admin' && admins.length > 1);

  return (
    <Modal open={open} onClose={handleClose} title={`Edit ${member.display_name}`} size="lg">
      <div className="max-h-[calc(80vh-100px)] overflow-y-auto px-1">
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <Input
            label="Display Name"
            placeholder="Full name"
            error={errors.display_name?.message}
            {...register('display_name')}
          />

          {/* Role - with warning for last admin */}
          <Select
            label="Role"
            options={ROLES}
            error={errors.role?.message}
            disabled={!canEditRole}
            {...register('role')}
          />
          {isSelf && member.role === 'admin' && admins.length === 1 && (
            <p className="text-xs text-warning -mt-2">You are the last admin. Promote another member first to change your role.</p>
          )}

          {/* Active Status - only for admins editing others */}
          {!isSelf && (
            <Select
              label="Status"
              options={ACTIVE_OPTIONS}
              {...register('is_active', { setValueAs: (v) => v === 'true' })}
            />
          )}

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
              options={admins.filter(a => a.id !== member.id).map(a => ({ value: a.id, label: a.display_name }))}
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

          {/* Admin Notes - only visible to admins editing others */}
          {!isSelf && (
            <Textarea
              label="Admin Notes (private)"
              placeholder="Internal notes about this member..."
              rows={2}
              {...register('admin_notes')}
            />
          )}

          <div className="flex gap-3 pt-2">
            <Button variant="secondary" fullWidth type="button" onClick={handleClose}>
              Cancel
            </Button>
            <Button fullWidth type="submit" loading={updateMutation.isPending}>
              Save Changes
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}