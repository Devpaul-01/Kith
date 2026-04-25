import{cn}from'@/utils/cn';import{Spinner}from'./Spinner';import type{ButtonHTMLAttributes}from'react';
interface Props extends ButtonHTMLAttributes<HTMLButtonElement>{variant?:'primary'|'secondary'|'danger'|'ghost';size?:'sm'|'md'|'lg';loading?:boolean;fullWidth?:boolean;}
export function Button({variant='primary',size='md',loading,fullWidth,children,className,disabled,...props}:Props){
  const base='inline-flex items-center justify-center gap-2 font-semibold rounded-xl transition-all duration-150 focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed';
  const variants={primary:'bg-primary text-white hover:bg-primary-hover focus:ring-primary shadow-sm',secondary:'bg-white text-text-primary border border-border hover:bg-slate-50 focus:ring-primary',danger:'bg-danger text-white hover:bg-red-600 focus:ring-danger',ghost:'text-text-secondary hover:bg-slate-100 focus:ring-slate-300'};
  const sizes={sm:'px-3 py-1.5 text-sm',md:'px-4 py-2.5 text-sm',lg:'px-6 py-3 text-base'};
  return<button className={cn(base,variants[variant],sizes[size],fullWidth&&'w-full',className)} disabled={disabled||loading} {...props}>{loading&&<Spinner size="sm"/>}{children}</button>;
}
