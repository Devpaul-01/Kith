import{cn}from'@/utils/cn';import{forwardRef,InputHTMLAttributes}from'react';
interface Props extends InputHTMLAttributes<HTMLInputElement>{label?:string;error?:string;hint?:string;}
export const Input=forwardRef<HTMLInputElement,Props>(({label,error,hint,className,...props},ref)=>(
  <div className="flex flex-col gap-1.5">
    {label&&<label className="text-sm font-medium text-text-primary">{label}</label>}
    <input ref={ref} className={cn('w-full rounded-xl border px-3.5 py-2.5 text-sm text-text-primary bg-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all',error?'border-danger focus:ring-danger':'border-border',className)} {...props}/>
    {error&&<p className="text-xs text-danger">{error}</p>}
    {hint&&!error&&<p className="text-xs text-text-secondary">{hint}</p>}
  </div>
));
Input.displayName='Input';
