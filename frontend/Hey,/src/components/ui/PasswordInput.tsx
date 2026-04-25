import{forwardRef,InputHTMLAttributes,useState}from'react';import{Eye,EyeOff}from'lucide-react';import{cn}from'@/utils/cn';import{usePasswordStrength}from'@/hooks/usePasswordStrength';
interface Props extends InputHTMLAttributes<HTMLInputElement>{label?:string;error?:string;showStrength?:boolean;}
export const PasswordInput=forwardRef<HTMLInputElement,Props>(({label,error,showStrength,className,value,...props},ref)=>{
  const[show,setShow]=useState(false);
  const strength=usePasswordStrength(typeof value==='string'?value:'');
  const sc={weak:'bg-danger',medium:'bg-warning',strong:'bg-success'};
  const sw={weak:'w-1/3',medium:'w-2/3',strong:'w-full'};
  return(
    <div className="flex flex-col gap-1.5">
      {label&&<label className="text-sm font-medium text-text-primary">{label}</label>}
      <div className="relative">
        <input ref={ref} type={show?'text':'password'} value={value} className={cn('w-full rounded-xl border px-3.5 py-2.5 text-sm pr-10 text-text-primary bg-white placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all',error?'border-danger focus:ring-danger':'border-border',className)} {...props}/>
        <button type="button" onClick={()=>setShow(s=>!s)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">{show?<EyeOff size={16}/>:<Eye size={16}/>}</button>
      </div>
      {showStrength&&typeof value==='string'&&value.length>0&&(<div className="space-y-1"><div className="h-1 bg-slate-100 rounded-full overflow-hidden"><div className={cn('h-full rounded-full transition-all duration-300',sc[strength],sw[strength])}/></div><p className="text-xs text-text-secondary capitalize">{strength} password</p></div>)}
      {error&&<p className="text-xs text-danger">{error}</p>}
    </div>
  );
});
PasswordInput.displayName='PasswordInput';
