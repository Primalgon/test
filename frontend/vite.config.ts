import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    target: 'es2022',
    cssCodeSplit: true,

    /**
     * Never ship source maps.
     *
     * A source map is the original code — component names, comments, folder
     * structure, and any string you thought was buried in a build. Devtools
     * loads it automatically, so shipping one means the "minified" bundle is
     * cosmetic. This is the single biggest thing people accidentally expose,
     * and it is one boolean.
     *
     * Set to 'hidden' instead if you use error tracking: maps are generated for
     * upload to Sentry but the `//# sourceMappingURL` comment is omitted, so no
     * browser fetches them.
     */
    sourcemap: false,

    minify: 'terser',
    terserOptions: {
      compress: {
        // console.log left in production leaks internal state, object shapes,
        // and sometimes tokens straight into anyone's devtools console.
        drop_console: true,
        drop_debugger: true,
        // Strips `if (import.meta.env.DEV)` branches entirely rather than
        // shipping dead code that documents what the dev build does.
        passes: 2,
      },
      mangle: {
        // Rename everything, including top-level. Function and variable names
        // are free documentation for anyone reading the bundle.
        toplevel: true,
      },
      format: {
        // Comments survive minification by default. Licence banners are fine;
        // your architectural notes are not.
        comments: false,
      },
    },
    rollupOptions: {
      output: {
        /**
         * three.js and the R3F stack are ~600kB gzipped and are the single
         * largest cost on any 3D site. Splitting them into their own chunk is
         * what makes the lazy WebGL gate in ThreeStage actually pay off: a
         * visitor on a device with no WebGL, or with prefers-reduced-motion,
         * downloads the poster image and never fetches this chunk at all.
         */
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('three') || id.includes('@react-three')) return 'three';
            if (id.includes('react-router')) return 'router';
            if (id.includes('react')) return 'react';
          }
        },
        assetFileNames: 'assets/[name]-[hash][extname]',
        chunkFileNames: 'assets/[name]-[hash].js',
      },
    },
    // Fail the build rather than quietly shipping a slow site. Step 5 QA reads this.
    chunkSizeWarningLimit: 700,
    assetsInlineLimit: 4096,
  },
  server: {
    proxy: {
      '/api': { target: process.env.VITE_API_ORIGIN ?? 'http://127.0.0.1:8787', changeOrigin: true },
      '/healthz': { target: process.env.VITE_API_ORIGIN ?? 'http://127.0.0.1:8787', changeOrigin: true },
    },
  },
});
