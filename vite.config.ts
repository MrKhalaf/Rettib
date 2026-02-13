import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'

const projectRoot = path.dirname(fileURLToPath(import.meta.url))
const rendererRoot = path.join(projectRoot, 'src/renderer')

export default defineConfig({
  root: rendererRoot,
  plugins: [
    react(),
    electron({
      main: {
        entry: path.join(projectRoot, 'src/main/index.ts'),
        vite: {
          build: {
            outDir: path.join(projectRoot, 'dist-electron'),
            emptyOutDir: true,
            rollupOptions: {
              external: ['better-sqlite3', 'level', 'node-pty'],
              output: {
                format: 'es',
                entryFileNames: 'index.js'
              }
            }
          }
        }
      },
      preload: {
        input: path.join(projectRoot, 'src/preload/index.ts'),
        vite: {
          build: {
            outDir: path.join(projectRoot, 'dist-electron'),
            emptyOutDir: false,
            rollupOptions: {
              output: {
                format: 'cjs',
                entryFileNames: 'preload.cjs'
              }
            }
          }
        }
      },
      renderer: {}
    })
  ],
  build: {
    outDir: path.join(projectRoot, 'dist/renderer'),
    emptyOutDir: true
  },
  resolve: {
    alias: {
      '@renderer': rendererRoot,
      '@shared': path.join(projectRoot, 'src/shared')
    }
  }
})
