import{AlertCircle}from'lucide-react';import{Button}from'./Button';import React from'react';
interface Props{message?:string;onRetry?:()=>void;}
export function ErrorState({message='Something went wrong.',onRetry}:Props){return(<div className="flex flex-col items-center justify-center py-16 gap-3 text-center"><AlertCircle className="text-danger" size={32}/><p className="text-text-secondary text-sm">{message}</p>{onRetry&&<Button variant="ghost" size="sm" onClick={onRetry}>Try again</Button>}</div>);}
interface EBProps{children:React.ReactNode;}interface EBState{hasError:boolean;}
export class ErrorBoundary extends React.Component<EBProps,EBState>{state:EBState={hasError:false};static getDerivedStateFromError():EBState{return{hasError:true};}componentDidCatch(err:Error){console.error('[ErrorBoundary]',err);}render(){if(this.state.hasError)return<ErrorState onRetry={()=>this.setState({hasError:false})}/>;return this.props.children;}}
