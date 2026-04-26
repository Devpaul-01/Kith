import{ChevronLeft,ChevronRight}from'lucide-react';
interface Props{page:number;totalPages:number;onPageChange:(p:number)=>void;}
export function Pagination({page,totalPages,onPageChange}:Props){
  if(totalPages<=1)return null;
  return(<div className="flex items-center gap-2 justify-center mt-4"><button onClick={()=>onPageChange(page-1)} disabled={page<=1} className="p-2 rounded-lg border border-border hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"><ChevronLeft size={14}/></button><span className="text-sm text-text-secondary">Page {page} of {totalPages}</span><button onClick={()=>onPageChange(page+1)} disabled={page>=totalPages} className="p-2 rounded-lg border border-border hover:bg-slate-50 disabled:opacity-40 disabled:cursor-not-allowed"><ChevronRight size={14}/></button></div>);
}
