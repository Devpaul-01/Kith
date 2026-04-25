import{useWorkspaceStore}from'@/store/workspaceStore';
export function useMember(){return useWorkspaceStore(s=>s.member);}
