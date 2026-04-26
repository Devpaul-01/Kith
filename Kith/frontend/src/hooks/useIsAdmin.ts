import{useWorkspaceStore}from'@/store/workspaceStore';
export function useIsAdmin():boolean{return useWorkspaceStore(s=>s.member?.role==='admin')??false;}
