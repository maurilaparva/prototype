import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

// https://vitejs.dev/config/
export default defineConfig({
  base: '/prototype',
  plugins: [react()],
  server: {
    port: 5185, // Set your desired port here
  },
})
