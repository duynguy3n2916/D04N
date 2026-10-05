import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Ứng dụng được FastAPI phục vụ tại /app/ (thư mục dist). Khi `npm run dev`, các lời gọi /ai/* được chuyển tới backend.
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/ai': 'http://localhost:8000',
      '/health': 'http://localhost:8000',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
});
