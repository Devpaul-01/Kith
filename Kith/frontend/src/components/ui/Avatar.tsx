import{cn}from'@/utils/cn';
interface Props{src?:string|null;name?:string;size?:'xs'|'sm'|'md'|'lg';className?:string;}
export function Avatar({src,name,size='md',className}:Props){
  const s={xs:'w-6 h-6 text-xs',sm:'w-8 h-8 text-sm',md:'w-10 h-10 text-sm',lg:'w-14 h-14 text-lg'};
  const initials=(name??'?').split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase();
  const colors=['bg-blue-100 text-blue-700','bg-purple-100 text-purple-700','bg-green-100 text-green-700','bg-orange-100 text-orange-700','bg-pink-100 text-pink-700'];
  const color=colors[(name?.charCodeAt(0)??0)%colors.length];
  if(src)return<img src={src} alt={name??''} className={cn('rounded-full object-cover',s[size],className)}/>;
  return<div className={cn('rounded-full flex items-center justify-center font-bold',s[size],color,className)}>{initials}</div>;
}
