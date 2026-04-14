/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html','./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        primary:  { DEFAULT:'#2563EB', hover:'#1D4ED8', light:'#DBEAFE' },
        text:     { primary:'#0F172A', secondary:'#475569' },
        border:   '#E2E8F0',
        surface:  { page:'#F8FAFC', card:'#FFFFFF' },
        success:  '#22C55E', warning:'#F59E0B', danger:'#EF4444', accent:'#7C3AED',
      },
      fontFamily: { sans: ['Plus Jakarta Sans','system-ui','sans-serif'] },
      boxShadow: {
        card: '0 1px 3px 0 rgb(0 0 0/0.07),0 1px 2px -1px rgb(0 0 0/0.07)',
        'card-hover': '0 4px 12px 0 rgb(0 0 0/0.10)',
        dropdown: '0 10px 40px -4px rgb(0 0 0/0.12)',
      },
    },
  },
  plugins: [],
};
