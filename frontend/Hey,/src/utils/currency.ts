import{CURRENCY_SYMBOLS}from'@/constants/currencies';
export function formatCurrency(amount:number,currency:string):string{const sym=CURRENCY_SYMBOLS[currency]??currency;return sym+new Intl.NumberFormat('en-US',{minimumFractionDigits:0,maximumFractionDigits:2}).format(amount);}
