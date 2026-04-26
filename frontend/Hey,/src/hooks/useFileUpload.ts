import{useState}from'react';import showToast from'@/lib/toast';import type{FileInfo}from'@/types/models';
interface UploadResult{upload_url:string;file_path:string;}
export function useFileUpload(){
  const[uploading,setUploading]=useState(false);
  const[progress,setProgress]=useState(0);
  async function uploadFile(getUrlFn:(f:FileInfo)=>Promise<UploadResult>,confirmFn:(filePath:string,filename:string)=>Promise<void>,file:File):Promise<{file_path:string}|null>{
    setUploading(true);setProgress(0);
    try{
      const{upload_url,file_path}=await getUrlFn({filename:file.name,content_type:file.type,file_size:file.size});
      setProgress(33);
      const res=await fetch(upload_url,{method:'PUT',headers:{'Content-Type':file.type},body:file});
      if(!res.ok)throw new Error('Storage upload failed. Please try again.');
      setProgress(66);
      await confirmFn(file_path,file.name);
      setProgress(100);
      return{file_path};
    }catch(e:unknown){showToast.error((e as{message?:string})?.message??'Upload failed');return null;}
    finally{setUploading(false);}
  }
  return{uploadFile,uploading,progress};
}
