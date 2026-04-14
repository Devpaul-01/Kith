import{api}from'@/lib/axios';
export const memberService={
  list:(w:string,p?:Record<string,unknown>)=>api.get(`/v1/workspaces/${w}/members`,{params:p}).then(r=>r.data),
  get:(w:string,m:string)=>api.get(`/v1/workspaces/${w}/members/${m}`).then(r=>r.data),
  create:(w:string,p:{display_name:string;role?:string;is_proxy?:boolean})=>api.post(`/v1/workspaces/${w}/members`,p).then(r=>r.data),
  update:(w:string,m:string,p:Partial<{display_name:string;role:string;is_active:boolean}>)=>api.patch(`/v1/workspaces/${w}/members/${m}`,p).then(r=>r.data),
  delete:(w:string,m:string)=>api.delete(`/v1/workspaces/${w}/members/${m}`).then(r=>r.data),
  getEngagement:(w:string)=>api.get(`/v1/workspaces/${w}/members/engagement`).then(r=>r.data),
  getContributionSummary:(w:string,m:string)=>api.get(`/v1/workspaces/${w}/members/${m}/contribution-summary`).then(r=>r.data),
};