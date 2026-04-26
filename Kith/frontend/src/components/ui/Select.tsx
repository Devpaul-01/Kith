import{cn}from'@/utils/cn';import{forwardRef,SelectHTMLAttributes}from'react';import{ChevronDown}from'lucide-react';
interface Option{value:string;label:string;}
interface Props extends SelectHTMLAttributes<HTMLSelectElement>{label?:string;error?:string;options:Option[];placeholder?:string;}
export const Select=forwardRef<HTMLSelectElement,Props>(({label,error,options,placeholder,className,...props},ref)=>(
  <div className="flex flex-col gap-1.5">
    {label&&<label className="text-sm font-medium text-text-primary">{label}</label>}
    <div className="relative">
      <select ref={ref} className={cn('w-full appearance-none rounded-xl border px-3.5 py-2.5 text-sm text-text-primary bg-white focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all pr-9',error?'border-danger':'border-border',className)} {...props}>
        {placeholder&&<option value="">{placeholder}</option>}
        {options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      <ChevronDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"/>
    </div>
    {error&&<p className="text-xs text-danger">{error}</p>}
  </div>
));
Select.displayName='Select';
