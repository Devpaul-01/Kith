import{formatCurrency}from'@/utils/currency';
interface Props{amount:number;currency:string;className?:string;}
export function CurrencyAmount({amount,currency,className}:Props){return<span className={className}>{formatCurrency(amount,currency)}</span>;}
