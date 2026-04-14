import type{ApiError}from'@/types/api';
export function parseApiError(error:unknown):ApiError{
  const e=error as{isAxiosError?:boolean;response?:{status:number;data:Record<string,unknown>};message?:string};
  if(e?.isAxiosError){
    const res=e.response;
    if(res){const b=res.data as{error?:{code?:string;message?:string;field?:string;data?:Record<string,unknown>};message?:string};return{status:res.status,code:b?.error?.code??'UNKNOWN',message:b?.error?.message??b?.message??'An error occurred',field:b?.error?.field,data:b?.error?.data};}
    return{status:0,code:'NETWORK_ERROR',message:'Network error — please check your connection.'};
  }
  if(error instanceof Error)return{status:500,code:'CLIENT_ERROR',message:error.message};
  return{status:500,code:'UNKNOWN',message:'An unexpected error occurred.'};
}
export function getErrorMessage(e:unknown):string{return parseApiError(e).message;}
