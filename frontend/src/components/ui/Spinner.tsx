import{cn}from'@/utils/cn';interface Props{size?:'sm'|'md'|'lg';className?:string;}
export function Spinner({size='md',className}:Props){const s={sm:'w-4 h-4 border-2',md:'w-6 h-6 border-2',lg:'w-10 h-10 border-[3px]'};return<div className={cn('rounded-full border-primary-light border-t-primary animate-spin',s[size],className)}/>;}
