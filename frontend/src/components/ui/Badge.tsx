import{cn}from'@/utils/cn';import{getStatusStyle}from'@/utils/statusColor';
interface Props{status:string;label?:string;className?:string;}
export function Badge({status,label,className}:Props){return<span className={cn('inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold',getStatusStyle(status),className)}>{label??status.replace(/_/g,' ')}</span>;}
