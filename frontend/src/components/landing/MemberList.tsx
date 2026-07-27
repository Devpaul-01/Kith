import { FamilyAvatar } from './FamilyAvatar';
import { DEMO_MEMBERS, PROXY_REPRESENTATIVE } from '@/constants/demoFamily';

export function MemberList() {
  return (
    <div className="rounded-2xl border border-border bg-white p-2 shadow-card">
      {DEMO_MEMBERS.map((m) => (
        <div key={m.id} className="flex items-center gap-3 rounded-xl px-3 py-2.5 hover:bg-surface-page transition-colors">
          <FamilyAvatar name={m.display_name} isProxy={m.is_proxy} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-text-primary">{m.display_name}</p>
            <p className="text-xs text-text-secondary">
              {m.is_proxy ? PROXY_REPRESENTATIVE[m.id] : m.role === 'admin' ? 'Admin' : 'Member'}
            </p>
          </div>
          {m.is_proxy && (
            <span className="shrink-0 rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-semibold text-text-secondary">
              Proxy member
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
