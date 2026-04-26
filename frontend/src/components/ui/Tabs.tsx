import{cn}from'@/utils/cn';
interface Tab{id:string;label:string;}interface Props{tabs:Tab[];activeTab:string;onChange:(id:string)=>void;className?:string;}
export function Tabs({tabs,activeTab,onChange,className}:Props){return(<div className={cn('flex gap-1 bg-slate-100 p-1 rounded-xl',className)}>{tabs.map(t=>(<button key={t.id} onClick={()=>onChange(t.id)} className={cn('flex-1 px-3 py-2 text-sm font-medium rounded-lg transition-all',activeTab===t.id?'bg-white text-text-primary shadow-sm':'text-text-secondary hover:text-text-primary')}>{t.label}</button>))}</div>);}
