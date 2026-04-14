import{api}from'@/lib/axios';import type{FileInfo}from'@/types/models';
export const authService={
  signup:(p:{email:string;password:string;full_name:string;country_of_residence:string})=>api.post('/v1/auth/signup',p).then(r=>r.data),
  login:(p:{email:string;password:string})=>api.post('/v1/auth/login',p).then(r=>r.data),
  refreshToken:(t:string)=>api.post('/v1/auth/refresh',{refresh_token:t}).then(r=>r.data),
  logout:()=>api.post('/v1/auth/logout').then(r=>r.data),
  forgotPassword:(email:string)=>api.post('/v1/auth/forgot-password',{email}).then(r=>r.data),
  resetPassword:(password:string)=>api.post('/v1/auth/reset-password',{password}).then(r=>r.data),
  getGoogleUrl:(redirectTo?:string)=>{const p=redirectTo?`?redirect_to=${encodeURIComponent(redirectTo)}`:'';return api.get(`/v1/auth/google/url${p}`).then(r=>r.data);},
  register:(p?:{full_name?:string;country_of_residence?:string})=>api.post('/v1/auth/register',p??{}).then(r=>r.data),
  getMe:()=>api.get('/v1/auth/me').then(r=>r.data),
  updateProfile:(p:Partial<{full_name:string;bio:string;country_of_residence:string;timezone:string;avatar_url:string}>)=>api.patch('/v1/auth/profile',p).then(r=>r.data),
  getAvatarUploadUrl:(f:FileInfo)=>api.post('/v1/auth/avatar/upload-url',f).then(r=>r.data),
  updateContacts:(contacts:Array<{type:string;value:string;label?:string;country_code?:string;is_primary?:boolean}>)=>api.patch('/v1/auth/contacts',{contacts}).then(r=>r.data),
  registerPushToken:(token:string,platform:'web'|'ios'|'android')=>api.post('/v1/auth/push-token',{token,platform}).then(r=>r.data),
  updateNotificationPrefs:(p:{push_enabled?:boolean;email_digest_enabled?:boolean})=>api.patch('/v1/auth/notification-preferences',p).then(r=>r.data),
  requestDataExport:()=>api.post('/v1/auth/request-data-export').then(r=>r.data),
};