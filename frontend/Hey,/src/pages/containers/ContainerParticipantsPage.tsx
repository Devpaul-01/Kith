import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { participantService, type ParticipantInput } from '@/services/participant.service';
import { AddFromGroupModal } from '@/components/participants/AddFromGroupModal';

import { memberService } from '@/services/member.service';
import { containerService } from '@/services/container.service';
import { KEYS } from '@/constants/queryKeys';
import { useWorkspace } from '@/hooks/useWorkspace';
import { Spinner } from '@/components/ui/Spinner';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';
import { Avatar } from '@/components/ui/Avatar';
import { CurrencyAmount } from '@/components/ui/CurrencyAmount';
import { AddParticipantsModal } from '@/components/ui/AddParticipantsModal';
import { EditParticipantModal } from '@/components/participants/EditParticipantModal';
import { TargetHistoryModal } from '@/components/participants/TargetHistoryModal';
import { CycleTargetsModal } from '@/components/participants/CycleTargetsModal';
import { useState, useEffect } from 'react';
import { Plus, Users,UsersRound, MoreVertical } from 'lucide-react';
import showToast from '@/lib/toast';
import type { Participant, WorkspaceMember } from '@/types/models';

export default function ContainerParticipantsPage() {
  const { id } = useParams<{ id: string }>();
  const { workspaceId } = useWorkspace();
  const qc = useQueryClient();

  const [showAdd, setShowAdd] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [editParticipant, setEditParticipant] = useState<Participant | null>(null);
  const [historyParticipant, setHistoryParticipant] = useState<Participant | null>(null);
  const [cycleParticipant, setCycleParticipant] = useState<Participant | null>(null);
  const [showAddFromGroup, setShowAddFromGroup] = useState(false);

  // Close dropdown when clicking anywhere outside
  useEffect(() => {
    if (!openMenuId) return;
    function handleClick() { setOpenMenuId(null); }
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [openMenuId]);

  const { data: containerData } = useQuery({
    queryKey: KEYS.container(workspaceId, id!),
    queryFn: () => containerService.get(workspaceId, id!),
    enabled: !!id,
  });

  const { data, isLoading } = useQuery({
    queryKey: KEYS.participants(workspaceId, id!),
    queryFn: () => participantService.list(workspaceId, id!),
  });
  const participants: Participant[] = (data as { participants?: Participant[] })?.participants ?? [];

  const { data: membersData } = useQuery({
    queryKey: KEYS.members(workspaceId),
    queryFn: () => memberService.list(workspaceId),
  });
  const members: WorkspaceMember[] = (membersData as { members?: WorkspaceMember[] })?.members ?? [];

  const container = containerData as any;
  const enableMoney   = container?.container?.enable_money ?? true;
  const enableTasks   = container?.container?.enable_tasks ?? false;
  const isActive      = container?.container?.status === 'active';
  const isRecurring   = container?.container?.container_type === 'recurring';

  const addMutation = useMutation({
    mutationFn: (participants: ParticipantInput[]) =>
      participantService.add(workspaceId, id!, participants),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.participants(workspaceId, id!) });
      showToast.success('Participants added');
      setShowAdd(false);
    },
    onError: (error: any) => {
      const message = error?.response?.data?.error?.message || error?.message || 'Failed to add participants';
      showToast.error(message);
    },
  });

  const removeMutation = useMutation({
    mutationFn: (pId: string) => participantService.remove(workspaceId, id!, pId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEYS.participants(workspaceId, id!) });
      showToast.success('Participant removed');
    },
    onError: (error: any) => {
      const message = error?.response?.data?.error?.message || 'Failed to remove participant';
      showToast.error(message);
    },
  });

  const handleMenuAction = (e: React.MouseEvent, action: string, participant: Participant) => {
    e.stopPropagation(); // prevent document click from firing twice
    setOpenMenuId(null);
    if (action === 'edit')    setEditParticipant(participant);
    if (action === 'history') setHistoryParticipant(participant);
    if (action === 'cycles')  setCycleParticipant(participant);
    if (action === 'remove')  removeMutation.mutate(participant.id);
  };

  return (
    <div className="p-4 sm:p-6 max-w-4xl mx-auto space-y-5">
      <div className="flex items-center justify-between">
  <h2 className="text-lg font-bold text-text-primary">Participants</h2>
  {isActive && (
    <div className="flex items-center gap-2">
      <Button size="sm" variant="secondary" onClick={() => setShowAddFromGroup(true)}>
        <UsersRound size={14} /> Add from Group
      </Button>
      <Button size="sm" onClick={() => setShowAdd(true)}>
        <Plus size={14} /> Add
      </Button>
    </div>
  )}
</div>

      {isLoading && <div className="flex justify-center py-8"><Spinner /></div>}

      {!isLoading && participants.length === 0 && (
        <EmptyState
          icon={<Users size={36} />}
          title="No participants"
          action={
            isActive
              ? <Button size="sm" onClick={() => setShowAdd(true)}><Plus size={14} />Add</Button>
              : undefined
          }
        />
      )}

      <div className="space-y-3">
        {participants.map(p => (
          <div key={p.id} className="bg-white border border-border rounded-xl p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Avatar name={p.display_name} size="sm" />
              <div>
                <p className="font-medium text-text-primary text-sm">{p.display_name}</p>
                <div className="flex gap-2 text-xs text-text-secondary flex-wrap">
                  {p.role && <span>Role: {p.role}</span>}
                  {p.money_enabled && <span>💰 Money</span>}
                  {p.tasks_enabled && <span>✅ Tasks</span>}
                  {p.exclude_from_public && <span>🔒 Private</span>}
                </div>
                {p.target_amount && (
                  <p className="text-xs text-text-secondary mt-0.5">
                    Target: <CurrencyAmount amount={p.target_amount} currency={p.target_currency || 'USD'} />
                    {p.due_date && ` · Due ${new Date(p.due_date).toLocaleDateString()}`}
                  </p>
                )}
              </div>
            </div>

            {/* 3-dot action menu */}
            <div className="relative">
              <button
                onClick={(e) => { e.stopPropagation(); setOpenMenuId(openMenuId === p.id ? null : p.id); }}
                className="p-1.5 rounded-lg hover:bg-surface text-text-secondary"
              >
                <MoreVertical size={16} />
              </button>

              {openMenuId === p.id && (
                <div className="absolute right-0 top-8 z-10 w-48 bg-white border border-border rounded-xl shadow-lg py-1">
                  <button
                    onClick={(e) => handleMenuAction(e, 'edit', p)}
                    className="w-full text-left px-3 py-2 text-sm text-text-primary hover:bg-surface"
                  >
                    Edit participant
                  </button>

                  {enableMoney && p.money_enabled && (
                    <button
                      onClick={(e) => handleMenuAction(e, 'history', p)}
                      className="w-full text-left px-3 py-2 text-sm text-text-primary hover:bg-surface"
                    >
                      View target history
                    </button>
                  )}

                  {isRecurring && (
                    <button
                      onClick={(e) => handleMenuAction(e, 'cycles', p)}
                      className="w-full text-left px-3 py-2 text-sm text-text-primary hover:bg-surface"
                    >
                      Cycle targets
                    </button>
                  )}

                  <div className="border-t border-border my-1" />

                  <button
                    onClick={(e) => handleMenuAction(e, 'remove', p)}
                    disabled={removeMutation.isPending}
                    className="w-full text-left px-3 py-2 text-sm text-danger hover:bg-surface disabled:opacity-50"
                  >
                    Remove
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Modals */}
      <AddParticipantsModal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        members={members}
        existingParticipantIds={participants.map(p => p.workspace_member_id)}
        onAdd={(participants) => addMutation.mutate(participants)}
        isPending={addMutation.isPending}
        enableMoney={enableMoney}
        enableTasks={enableTasks}
      />

      {editParticipant && (
        <EditParticipantModal
          open
          onClose={() => setEditParticipant(null)}
          participant={editParticipant}
          workspaceId={workspaceId}
          containerId={id!}
          enableMoney={enableMoney}
          enableTasks={enableTasks}
        />
      )}

      {historyParticipant && (
        <TargetHistoryModal
          open
          onClose={() => setHistoryParticipant(null)}
          participant={historyParticipant}
          workspaceId={workspaceId}
          containerId={id!}
        />
      )}

      {cycleParticipant && (
        <CycleTargetsModal
          open
          onClose={() => setCycleParticipant(null)}
          participant={cycleParticipant}
          workspaceId={workspaceId}
          containerId={id!}
        />
      )}
      {/* Add from Group Modal */}
<AddFromGroupModal
  open={showAddFromGroup}
  onClose={() => setShowAddFromGroup(false)}
  workspaceId={workspaceId}
  containerId={id!}
  enableMoney={enableMoney}
  enableTasks={enableTasks}
  onSuccess={() => {
    qc.invalidateQueries({ queryKey: KEYS.participants(workspaceId, id!) });
  }}
/>
    </div>
  );
}
