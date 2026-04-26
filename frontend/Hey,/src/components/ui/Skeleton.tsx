import{cn}from'@/utils/cn';
export function Skeleton({className}:{className?:string}){return<div className={cn('animate-pulse bg-slate-200 rounded-lg',className)}/>;}
export function SkeletonCard(){return<div className="bg-white rounded-2xl border border-border p-5 space-y-3"><Skeleton className="h-4 w-2/3"/><Skeleton className="h-3 w-1/2"/><Skeleton className="h-3 w-full"/></div>;}
