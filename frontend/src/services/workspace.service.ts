import{api}from'@/lib/axios';
export const workspaceService={
  list:()=>api.get('/v1/workspaces').then(r=>r.data),
  create:(p:{name:string;description?:string;base_currency:string;family_type?:string})=>api.post('/v1/workspaces',p).then(r=>r.data),
  get:(id:string)=>api.get(`/v1/workspaces/${id}`).then(r=>r.data),
  update:(id:string,p:Partial<{name:string;description:string;base_currency:string;family_type:string;avatar_url:string}>)=>api.patch(`/v1/workspaces/${id}`,p).then(r=>r.data),
  delete:(id:string)=>api.delete(`/v1/workspaces/${id}`).then(r=>r.data),
  getDashboard:(id:string)=>api.get(`/v1/workspaces/${id}/dashboard`).then(r=>r.data),
  getSettings:(id:string)=>api.get(`/v1/workspaces/${id}/settings`).then(r=>r.data),
  updateSettings:(id:string,p:Record<string,unknown>)=>api.patch(`/v1/workspaces/${id}/settings`,p).then(r=>r.data),
};