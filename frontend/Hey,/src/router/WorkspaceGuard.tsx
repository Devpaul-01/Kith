import{Navigate,Outlet}from'react-router-dom';import{useEffect}from'react';import{useWorkspaceStore}from'@/store/workspaceStore';import{workspaceService}from'@/services/workspace.service';import type{Workspace,WorkspaceMember}from'@/types/models';
export function WorkspaceGuard(){
  const{activeWorkspaceId,setWorkspace}=useWorkspaceStore();
  useEffect(()=>{if(activeWorkspaceId){workspaceService.get(activeWorkspaceId).then((d:unknown)=>{const{workspace,current_member}=d as{workspace:Workspace;current_member:WorkspaceMember};if(workspace&&current_member)setWorkspace(workspace,current_member);}).catch(()=>{});}},[activeWorkspaceId]);
  if(!activeWorkspaceId)return<Navigate to="/workspace/select" replace/>;
  return<Outlet/>;
}
