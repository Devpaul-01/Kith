import{useWorkspaceStore}from'@/store/workspaceStore';
export function useWorkspace(){const{activeWorkspaceId,workspace,member}=useWorkspaceStore();return{workspaceId:activeWorkspaceId??'',workspace,member};}
