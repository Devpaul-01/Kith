export interface PaginationMeta{page:number;per_page:number;total:number;total_pages:number;}
export interface ApiError{status:number;code:string;message:string;field?:string;data?:Record<string,unknown>;}
