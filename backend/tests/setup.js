jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'error').mockImplementation(() => {});

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
process.env.FRONTEND_URL = 'http://localhost:3000';
process.env.SUPABASE_URL = 'https://kpqwlnbmlultpbbitwol.supabase.co';
process.env.SUPABASE_ANON_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtwcXdsbmJtbHVsdHBiYml0d29sIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU2NTUwNjksImV4cCI6MjA5MTIzMTA2OX0.4Lp4_V5chiwgLop79lZ1HOJUK2fYuuE16st4eEi89E0';

process.env.SUPABASE_SERVICE_ROLE_KEY='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtwcXdsbmJtbHVsdHBiYml0d29sIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTY1NTA2OSwiZXhwIjoyMDkxMjMxMDY5fQ.Ck3m5zW-Ad-RL-sZzpZJvR3RAxn_drd5UbeTN-JrGzo';
