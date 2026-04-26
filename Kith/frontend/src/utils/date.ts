import{format,formatDistanceToNow,parseISO,isValid}from'date-fns';
export function formatDate(d?:string|null,fmt='MMM d, yyyy'):string{if(!d)return'—';const p=parseISO(d);return isValid(p)?format(p,fmt):'—';}
export function formatDateShort(d?:string|null){return formatDate(d,'MMM d');}
export function formatDateTime(d?:string|null){return formatDate(d,'MMM d, yyyy h:mm a');}
export function timeAgo(d?:string|null):string{if(!d)return'—';const p=parseISO(d);return isValid(p)?formatDistanceToNow(p,{addSuffix:true}):'—';}
export function daysUntil(d:string):number{const t=parseISO(d),now=new Date();now.setHours(0,0,0,0);return Math.ceil((t.getTime()-now.getTime())/86400000);}
