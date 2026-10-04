import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const mapVendor = /[\\/]node_modules[\\/](?:@xyflow|elkjs|d3-[a-z]+|zustand|classcat)[\\/]/

const vendor = /node_modules|[\\/]packages[\\/]contract[\\/]/

export default defineConfig({
  root: import.meta.dirname,
  base: '/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2024',
    chunkSizeWarningLimit: 1700,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'vendor', test: (id: string) => vendor.test(id) && !mapVendor.test(id), priority: 2 },
            { name: 'vendor-map', test: mapVendor, priority: 1 },
          ],
        },
      },
    },
  },
})
