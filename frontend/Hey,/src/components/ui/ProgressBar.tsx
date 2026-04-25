import{cn}from'@/utils/cn';
interface Props{value:number;max?:number;color?:string;className?:string;showLabel?:boolean;}
export function ProgressBar({value,max=100,color='bg-primary',className,showLabel}:Props){
  const pct=Math.min(100,Math.round((value/max)*100));
  return(<div className={cn('w-full',className)}>{showLabel&&<div className="flex justify-between text-xs text-text-secondary mb-1"><span>Progress</span><span>{pct}%</span></div>}<div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden"><div className={cn('h-full rounded-full transition-all duration-500',color)} style={{width:`${pct}%`}}/></div></div>);
}
