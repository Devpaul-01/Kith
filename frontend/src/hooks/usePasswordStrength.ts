export type PasswordStrength='weak'|'medium'|'strong';
export function getPasswordStrength(pw:string):PasswordStrength{const hasUpper=/[A-Z]/.test(pw),hasNumber=/[0-9]/.test(pw),hasLength=pw.length>=8;if(hasLength&&hasUpper&&hasNumber)return'strong';if(hasLength&&(hasUpper||hasNumber))return'medium';return'weak';}
export function usePasswordStrength(pw:string){return getPasswordStrength(pw);}
