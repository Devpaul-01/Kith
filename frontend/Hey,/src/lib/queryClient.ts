import{QueryClient}from'@tanstack/react-query';
export const queryClient=new QueryClient({defaultOptions:{queries:{staleTime:60_000,retry:(n,e:unknown)=>{const err=e as{status?:number};if(err?.status===401||err?.status===403||err?.status===404)return false;return n<2;},refetchOnWindowFocus:true},mutations:{retry:false}}});
