// components/cycles/CycleOverrideModal.tsx
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { participantService } from '@/services/participant.service';
import { KEYS } from '@/constants/queryKeys';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Textarea } from '@/components/ui/Textarea';
import showToast from '@/lib/toast';

interface CycleOverrideModalProps {
  open: boolean;
  onClose: () => void;
  workspaceId: string;
  containerId: string;
  cycleId: string;
  cycleNumber: number;
  participants: Array<{ id: string; display_name: string }>;
  currency: string;
}

type OverrideType = 'skip_member' | 'adjust_target' | 'pause_pool';

export function CycleOverrideModal({
  open,
  onClose,
  workspaceId,
  containerId,
  cycleId,
  cycleNumber,
  participants,
  currency,
}: CycleOverrideModalProps) {
  const qc = useQueryClient();
  const [overrideType, setOverrideType] = useState<OverrideType>('skip_member');
  const [selectedMemberId, setSelectedMemberId] = useState('');
  const [newTarget, setNewTarget] = useState('');
  const [newCurrency, setNewCurrency] = useState(currency);
  const [reason, setReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const overrideMutation = useMutation({
    mutationFn: async () => {
      let payload: any = {
        override_type: overrideType,
        reason: reason || undefined,
      };

      if (overrideType === 'skip_member') {
        if (!selectedMemberId) throw new Error('Please select a member to skip');
        payload.member_id = selectedMemberId;
      }

      if (overrideType === 'adjust_target') {
        if (!selectedMemberId) throw new Error('Please select a member');
        if (!newTarget || parseFloat(newTarget) <= 0) throw new Error('Please enter a valid target amount');
        payload.member_id = selectedMemberId;
        payload.new_target = parseFloat(newTarget);
        payload.new_currency = newCurrency;
      }

      return participantService.overrideCycle(workspaceId, containerId, cycleId, payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.cycles(workspaceId, containerId) });
      qc.invalidateQueries({ queryKey: KEYS.participants(workspaceId, containerId) });
      showToast.success(
        overrideType === 'skip_member' ? 'Member skipped for this cycle' :
        overrideType === 'adjust_target' ? 'Target adjusted for this cycle' :
        'Pool paused for this cycle'
      );
      onClose();
      resetForm();
    },
    onError: (error: any) => {
      const message = error?.response?.data?.error?.message || 'Failed to apply override';
      showToast.error(message);
    },
    onSettled: () => {
      setIsSubmitting(false);
    },
  });

  const resetForm = () => {
    setOverrideType('skip_member');
    setSelectedMemberId('');
    setNewTarget('');
    setNewCurrency(currency);
    setReason('');
  };

  const handleSubmit = () => {
    setIsSubmitting(true);
    overrideMutation.mutate();
  };

  return (
    <Modal open={open} onClose={onClose} title={`Override Cycle ${cycleNumber}`}>
      <div className="space-y-4">
        {/* Override Type Selection */}
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-text-secondary">
            Override Type
          </label>
          <div className="flex gap-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                value="skip_member"
                checked={overrideType === 'skip_member'}
                onChange={(e) => setOverrideType(e.target.value as OverrideType)}
                className="w-4 h-4 accent-primary"
              />
              <span className="text-sm text-text-primary">Skip Member</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                value="adjust_target"
                checked={overrideType === 'adjust_target'}
                onChange={(e) => setOverrideType(e.target.value as OverrideType)}
                className="w-4 h-4 accent-primary"
              />
              <span className="text-sm text-text-primary">Adjust Target</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                value="pause_pool"
                checked={overrideType === 'pause_pool'}
                onChange={(e) => setOverrideType(e.target.value as OverrideType)}
                className="w-4 h-4 accent-primary"
              />
              <span className="text-sm text-text-primary">Pause Pool</span>
            </label>
          </div>
        </div>

        {/* Member Selection (for skip_member and adjust_target) */}
        {(overrideType === 'skip_member' || overrideType === 'adjust_target') && (
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-text-secondary">
              Select Member
            </label>
            <select
              className="text-sm border border-border rounded-xl px-3 py-2 focus:outline-none bg-white w-full"
              value={selectedMemberId}
              onChange={(e) => setSelectedMemberId(e.target.value)}
            >
              <option value="">-- Select a member --</option>
              {participants.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Target Adjustment Fields */}
        {overrideType === 'adjust_target' && (
          <div className="grid grid-cols-2 gap-3">
            <Input
              label="New Target Amount"
              type="number"
              step="0.01"
              placeholder="0.00"
              value={newTarget}
              onChange={(e) => setNewTarget(e.target.value)}
            />
            <Input
              label="Currency"
              placeholder="USD"
              value={newCurrency}
              onChange={(e) => setNewCurrency(e.target.value.toUpperCase())}
            />
          </div>
        )}

        {/* Pause Pool Warning */}
        {overrideType === 'pause_pool' && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 p-3">
            <p className="text-sm text-amber-700">
              ⚠️ This will skip the entire cycle. No contributions will be collected for this cycle period.
            </p>
          </div>
        )}

        {/* Reason (optional) */}
        <Textarea
          label="Reason (optional)"
          placeholder="Why is this override being applied?"
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />

        <div className="flex gap-3 pt-2">
          <Button
            variant="secondary"
            fullWidth
            type="button"
            onClick={() => {
              onClose();
              resetForm();
            }}
          >
            Cancel
          </Button>
          <Button
            fullWidth
            onClick={handleSubmit}
            loading={isSubmitting}
            disabled={
              (overrideType === 'skip_member' && !selectedMemberId) ||
              (overrideType === 'adjust_target' && (!selectedMemberId || !newTarget))
            }
          >
            Apply Override
          </Button>
        </div>
      </div>
    </Modal>
  );
}