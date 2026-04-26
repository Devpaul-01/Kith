import*as Dialog from'@radix-ui/react-dialog';import{X}from'lucide-react';import{cn}from'@/utils/cn';
interface Props{open:boolean;onClose:()=>void;title?:string;description?:string;children:React.ReactNode;size?:'sm'|'md'|'lg';}
export function Modal({open,onClose,title,description,children,size='md'}:Props){
  const sizes={sm:'max-w-md',md:'max-w-lg',lg:'max-w-2xl'};
  return(
    <Dialog.Root open={open} onOpenChange={v=>!v&&onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-sm z-40"/>
        <Dialog.Content className={cn('fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[calc(100vw-2rem)] bg-white rounded-2xl shadow-2xl p-6 focus:outline-none',sizes[size])}>
          <div className="flex items-start justify-between mb-4">
            <div>{title&&<Dialog.Title className="text-lg font-bold text-text-primary">{title}</Dialog.Title>}{description&&<Dialog.Description className="text-sm text-text-secondary mt-0.5">{description}</Dialog.Description>}</div>
            <button onClick={onClose} className="ml-4 rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"><X size={18}/></button>
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
