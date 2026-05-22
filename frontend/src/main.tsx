import{StrictMode}from'react';
import{createRoot}from'react-dom/client';
import'./index.css';
import App from'./App';

if (import.meta.env.DEV || import.meta.env.VITE_DEBUG === 'true') {
  import('eruda').then(e => e.default.init());
}

createRoot(document.getElementById('root')!).render(<StrictMode><App/></StrictMode>);
