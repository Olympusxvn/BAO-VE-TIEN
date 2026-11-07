import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev proxy: the API lives on the backend (localhost:3000). The frontend
// never talks to PayPal directly.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
