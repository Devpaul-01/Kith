import{cn}from'@/utils/cn';import type{HTMLAttributes}from'react';
interface Props extends HTMLAttributes<HTMLDivElement>{padding?:'sm'|'md'|'lg';hover?:boolean;}
export function Card({padding='md',hover,className,children,...props}:Props){const p={sm:'p-3',md:'p-4 sm:p-5',lg:'p-6'};return<div className={cn('bg-surface-card rounded-2xl border border-border shadow-card',hover&&'cursor-pointer hover:shadow-card-hover transition-shadow',p[padding],className)} {...props}>{children}</div>;}
