import { defineConfig } from '@sanity/pkg-utils'

export default defineConfig({
  tsconfig: 'tsconfig.json',
  dist: 'dist',
  bundles: [
    {
      source: './src/index.ts',
      import: './dist/index.js',
      require: './dist/index.cjs',
    },
  ],
})
