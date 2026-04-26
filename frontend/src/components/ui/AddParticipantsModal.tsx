import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Checkbox } from '@/components/ui/Checkbox';
import { Textarea } from '@/components/ui/Textarea';
import { Avatar } from '@/components/ui/Avatar';
import { ChevronRight, ChevronLeft } from 'lucide-react';
import type { WorkspaceMember } from '@/types/models';

interface ParticipantFormData {
  workspace_member_id: string;
  money_enabled: boolean;
  tasks_enabled: boolean;
  role: string;
  notes: string;
  target_amount?: number;
  target_currency?: string;
  target_due_date?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  members: WorkspaceMember[];
  existingParticipantIds: string[];
  onAdd: (participants: ParticipantFormData[]) => void;
  isPending?: boolean;
  enableMoney?: boolean;
  enableTasks?: boolean;
}

export function AddParticipantsModal({ 
  open, 
  onClose, 
  members, 
  existingParticipantIds, 
  onAdd,
  isPending,
  enableMoney = true,
  enableTasks = false
}: Props) {
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set());
  const [currentMember, setCurrentMember] = useState<WorkspaceMember | null>(null);
  const [formData, setFormData] = useState<Record<string, ParticipantFormData>>({});

  const availableMembers = members.filter(m => !existingParticipantIds.includes(m.id));

  const getUnconfiguredMembers = () => {
    return Array.from(selectedMemberIds).filter(id => !formData[id]);
  };

  const handleSelectMember = (memberId: string, checked: boolean) => {
    const newSet = new Set(selectedMemberIds);
    if (checked) {
      newSet.add(memberId);
    } else {
      newSet.delete(memberId);
      // Remove form data if exists
      setFormData(prev => {
        const next = { ...prev };
        delete next[memberId];
        return next;
      });
    }
    setSelectedMemberIds(newSet);
  };

  const handleStartConfiguration = () => {
    const unconfigured = getUnconfiguredMembers();
    if (unconfigured.length === 0) return;
    
    const firstMember = availableMembers.find(m => m.id === unconfigured[0]);
    if (firstMember) {
      setCurrentMember(firstMember);
      if (!formData[firstMember.id]) {
        setFormData(prev => ({
          ...prev,
          [firstMember.id]: {
            workspace_member_id: firstMember.id,
            money_enabled: enableMoney,
            tasks_enabled: enableTasks,
            role: 'member',
            notes: '',
          }
        }));
      }
    }
  };

  const updateCurrentForm = (updates: Partial<ParticipantFormData>) => {
    if (currentMember) {
      setFormData(prev => ({
        ...prev,
        [currentMember.id]: { ...prev[currentMember.id], ...updates }
      }));
    }
  };

  const handleNext = () => {
    if (!currentMember) return;
    
    const unconfigured = getUnconfiguredMembers();
    const currentIndex = unconfigured.findIndex(id => id === currentMember.id);
    const nextMemberId = unconfigured[currentIndex + 1];
    
    if (nextMemberId) {
      const nextMember = availableMembers.find(m => m.id === nextMemberId);
      if (nextMember) {
        setCurrentMember(nextMember);
        if (!formData[nextMember.id]) {
          setFormData(prev => ({
            ...prev,
            [nextMember.id]: {
              workspace_member_id: nextMember.id,
              money_enabled: enableMoney,
              tasks_enabled: enableTasks,
              role: 'member',
              notes: '',
            }
          }));
        }
      }
    } else {
      // All configured, submit
      const participants = Array.from(selectedMemberIds).map(id => formData[id]);
      onAdd(participants);
      handleClose();
    }
  };

  const handlePrevious = () => {
    if (!currentMember) return;
    
    const unconfigured = getUnconfiguredMembers();
    const currentIndex = unconfigured.findIndex(id => id === currentMember.id);
    const prevMemberId = unconfigured[currentIndex - 1];
    
    if (prevMemberId) {
      const prevMember = availableMembers.find(m => m.id === prevMemberId);
      if (prevMember) setCurrentMember(prevMember);
    }
  };

  const handleClose = () => {
    setSelectedMemberIds(new Set());
    setCurrentMember(null);
    setFormData({});
    onClose();
  };

  const currentForm = currentMember ? formData[currentMember.id] : null;
  const unconfiguredCount = getUnconfiguredMembers().length;
  const configuredCount = selectedMemberIds.size - unconfiguredCount;

  return (
    <Modal open={open} onClose={handleClose} title="Add Participants" size="lg">
      {currentMember ? (
        // Configuration step
        <div className="space-y-4">
          <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
            <div className="flex items-center gap-3">
              <Avatar name={currentMember.display_name} size="md" />
              <div>
                <p className="font-medium text-text-primary">{currentMember.display_name}</p>
                <p className="text-xs text-text-secondary">
                  {configuredCount} of {selectedMemberIds.size} configured
                </p>
              </div>
            </div>
          </div>

          {enableMoney && (
            <>
              <div className="flex items-center gap-4">
                <Checkbox 
                  label="Enable money tracking"
                  checked={currentForm?.money_enabled}
                  onCheckedChange={(checked) => updateCurrentForm({ money_enabled: checked === true })}
                />
                <Checkbox 
                  label="Enable tasks"
                  checked={currentForm?.tasks_enabled}
                  onCheckedChange={(checked) => updateCurrentForm({ tasks_enabled: checked === true })}
                />
              </div>

              {currentForm?.money_enabled && (
                <div className="grid grid-cols-2 gap-3">
                  <Input 
                    label="Target Amount"
                    type="number"
                    placeholder="0.00"
                    value={currentForm?.target_amount || ''}
                    onChange={(e) => updateCurrentForm({ target_amount: parseFloat(e.target.value) })}
                  />
                  <Input 
                    label="Currency"
                    placeholder="USD"
                    value={currentForm?.target_currency || 'USD'}
                    onChange={(e) => updateCurrentForm({ target_currency: e.target.value })}
                  />
                  <Input 
                    label="Due Date (optional)"
                    type="date"
                    className="col-span-2"
                    value={currentForm?.target_due_date || ''}
                    onChange={(e) => updateCurrentForm({ target_due_date: e.target.value })}
                  />
                </div>
              )}
            </>
          )}

          <Input 
            label="Role (optional)"
            placeholder="e.g., Organizer, Treasurer"
            value={currentForm?.role || ''}
            onChange={(e) => updateCurrentForm({ role: e.target.value })}
          />

          <Textarea 
            label="Notes (optional)"
            placeholder="Any additional notes..."
            rows={2}
            value={currentForm?.notes || ''}
            onChange={(e) => updateCurrentForm({ notes: e.target.value })}
          />

          <div className="flex gap-3 pt-4">
            {unconfiguredCount > 1 && (
              <Button variant="secondary" onClick={handlePrevious}>
                <ChevronLeft size={16} /> Back
              </Button>
            )}
            <Button 
              fullWidth={unconfiguredCount === 1}
              className={unconfiguredCount > 1 ? "flex-1" : ""}
              onClick={handleNext}
              loading={isPending && unconfiguredCount === 1}
            >
              {unconfiguredCount === 1 ? 'Add Participants' : 'Next'}
              <ChevronRight size={16} />
            </Button>
          </div>
        </div>
      ) : (
        // Selection step
        <div className="space-y-3 max-h-96 overflow-y-auto">
          {availableMembers.length === 0 ? (
            <p className="text-center text-text-secondary py-8">No available members to add</p>
          ) : (
            availableMembers.map(member => (
              <label 
                key={member.id} 
                className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-slate-50 cursor-pointer transition-colors"
              >
                <input 
                  type="checkbox" 
                  checked={selectedMemberIds.has(member.id)}
                  onChange={(e) => handleSelectMember(member.id, e.target.checked)}
                  className="rounded"
                />
                <Avatar name={member.display_name} size="sm" />
                <div className="flex-1">
                  <p className="font-medium text-text-primary">{member.display_name}</p>
                  <p className="text-xs text-text-secondary capitalize">{member.role}</p>
                </div>
              </label>
            ))
          )}
          
          <div className="flex gap-3 pt-4">
            <Button variant="secondary" fullWidth onClick={handleClose}>
              Cancel
            </Button>
            <Button 
              fullWidth 
              onClick={handleStartConfiguration}
              disabled={selectedMemberIds.size === 0}
            >
              Configure ({selectedMemberIds.size})
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}