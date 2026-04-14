import{cn}from'@/utils/cn';import{forwardRef,TextareaHTMLAttributes}from'react';
interface Props extends TextareaHTMLAttributes<HTMLTextAreaElement>{label?:string;error?:string;}
export const Textarea=forwardRef<HTMLTextAreaElement,Props>(({label,error,className,...props},ref)=>(
  <div className="flex flex-col gap-1.5">
    {label&&<label className="text-sm font-medium text-text-primary">{label}</label>}
    <textarea ref={ref} className={cn('w-full rounded-xl border px-3.5 py-2.5 text-sm text-text-primary bg-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all resize-none',error?'border-danger':'border-border',className)} {...props}/>
    {error&&<p className="text-xs text-danger">{error}</p>}
  </div>
));
Textarea.displayName='Textarea';
