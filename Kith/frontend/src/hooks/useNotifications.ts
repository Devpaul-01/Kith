import{useQuery,useMutation,useQueryClient,useInfiniteQuery}from'@tanstack/react-query';
import{notificationService}from'@/services/notification.service';
import{KEYS}from'@/constants/queryKeys';
import{useWorkspace}from'./useWorkspace';
export function useNotificationCount(){const{workspaceId}=useWorkspace();return useQuery({queryKey:KEYS.notificationCount(),queryFn:()=>notificationService.getCount(workspaceId||undefined),refetchInterval:30_000,staleTime:0});}
export function useNotifications(){const{workspaceId}=useWorkspace();return useInfiniteQuery({queryKey:KEYS.notifications(),queryFn:({pageParam=1})=>notificationService.list({page:pageParam as number,per_page:20,workspace_id:workspaceId||undefined}),initialPageParam:1,getNextPageParam:(last:Record<string,unknown>)=>{const meta=last?.meta as{pagination?:{page:number;total_pages:number}}|undefined;if(meta?.pagination&&meta.pagination.page<meta.pagination.total_pages)return meta.pagination.page+1;return undefined;}});}
export function useMarkRead(){const qc=useQueryClient();return useMutation({mutationFn:(id:string)=>notificationService.markRead(id),onSuccess:()=>{qc.invalidateQueries({queryKey:KEYS.notifications()});qc.invalidateQueries({queryKey:KEYS.notificationCount()});}});}
export function useMarkAllRead(){const qc=useQueryClient();const{workspaceId}=useWorkspace();return useMutation({mutationFn:()=>notificationService.markAllRead(workspaceId||undefined),onSuccess:()=>{qc.invalidateQueries({queryKey:KEYS.notifications()});qc.invalidateQueries({queryKey:KEYS.notificationCount()});}});}
