import axios from'axios';
import{parseApiError}from'@/utils/errors';
export const api=axios.create({baseURL:import.meta.env.VITE_API_BASE_URL as string,headers:{'Content-Type':'application/json'},withCredentials:true, timeout:30_000});
api.interceptors.request.use(async(config)=>{
  const{useAuthStore}=await import('@/store/authStore');
  const{session}=useAuthStore.getState();
  if(session?.access_token)config.headers.Authorization=`Bearer ${session.access_token}`;
  return config;
});
api.interceptors.response.use(
  (res)=>{if(res.data?.data!==undefined)return{...res,data:{...res.data.data,meta:res.data.meta}};return res;},
  async(error)=>{
    const orig=error.config as typeof error.config&{_retry?:boolean};
    if(error.response?.status===401&&!orig._retry){
      orig._retry=true;
      try{
        const{useAuthStore}=await import('@/store/authStore');
        const{session}=useAuthStore.getState();
        if(!session?.refresh_token)throw new Error('no refresh');
        const{data}=await api.post('/v1/auth/refresh',{refresh_token:session.refresh_token});
        useAuthStore.getState().setSession(data.access_token,data.refresh_token);
        orig.headers=orig.headers??{};
        orig.headers.Authorization=`Bearer ${data.access_token}`;
        return api(orig);
      }catch{
        const{useAuthStore}=await import('@/store/authStore');
        useAuthStore.getState().clear();
        window.location.href='/login?reason=session_expired';
      }
    }
    return Promise.reject(error);
  }
);
