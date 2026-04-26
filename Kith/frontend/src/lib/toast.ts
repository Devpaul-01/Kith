import toast from'react-hot-toast';
export const showToast={success:(m:string)=>toast.success(m,{duration:3500}),error:(m:string)=>toast.error(m,{duration:5000}),loading:(m:string)=>toast.loading(m),dismiss:(id?:string)=>toast.dismiss(id)};
export default showToast;
