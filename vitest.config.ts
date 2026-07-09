import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // `@shared/*` mirrors the tsconfig path so a main-process module under test
  // can import shared code the same way it does at build time.
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared')
    }
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node'
  }
})
