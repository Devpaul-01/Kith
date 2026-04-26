import { useQuery } from '@tanstack/react-query';
import { workspaceService } from '@/services/workspace.service';
import { KEYS } from '@/constants/queryKeys';
import { useWorkspaceStore } from '@/store/workspaceStore';
import { useNavigate, Link } from 'react-router-dom';
import { Spinner } from '@/components/ui/Spinner';
import { Building2, Plus } from 'lucide-react';
import type { Membership } from '@/types/models';

export default function WorkspaceSelectPage() {
  const { setActive } = useWorkspaceStore();
  const nav = useNavigate();
  const { data, isLoading } = useQuery({ queryKey: KEYS.workspaces(), queryFn: () => workspaceService.list() });
  const memberships: Membership[] = (data as { memberships?: Membership[] })?.memberships ?? [];

  return (
    <div className="min-h-screen bg-surface-page flex items-center justify-center p-4">
      <div className="w-full max-w-md space-y-4">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-extrabold text-text-primary">ki<span className="text-primary">th</span></h1>
          <p className="text-text-secondary mt-2">Choose a workspace to continue</p>
        </div>
        {isLoading && <div className="flex justify-center py-8"><Spinner /></div>}
        {memberships.map(m => (
          <button key={m.workspace_id} onClick={() => { setActive(m.workspace_id); nav('/app/dashboard'); }}
            className="w-full bg-white border border-border rounded-2xl p-5 text-left hover:border-primary hover:shadow-card-hover transition-all flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-primary-light flex items-center justify-center"><Building2 className="text-primary" size={22} /></div>
            <div>
              <p className="font-semibold text-text-primary">{m.workspace_name}</p>
              <p className="text-xs text-text-secondary capitalize">{m.role} · {m.base_currency}</p>
            </div>
          </button>
        ))}
        <Link to="/workspace/create" className="flex items-center justify-center gap-2 w-full border-2 border-dashed border-border rounded-2xl p-5 text-text-secondary hover:border-primary hover:text-primary transition-colors font-medium text-sm">
          <Plus size={16} />Create new workspace
        </Link>
      </div>
    </div>
  );
}
