import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import JavaScriptObfuscator from "javascript-obfuscator";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const edition = process.env.EDITION || 'stable';

/** Production-only JS obfuscation: makes extracted frontend code unreadable. */
function obfuscatePlugin(): import('vite').Plugin {
  return {
    name: 'obfuscate',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const key in bundle) {
        const chunk = bundle[key];
        if (chunk.type === 'chunk') {
          const result = JavaScriptObfuscator.obfuscate(chunk.code, {
            compact: true,
            controlFlowFlattening: true,
            controlFlowFlatteningThreshold: 0.75,
            deadCodeInjection: true,
            deadCodeInjectionThreshold: 0.3,
            stringArray: true,
            stringArrayEncoding: ['base64'],
            stringArrayThreshold: 0.75,
            // Preserve: don't break React component names for DevTools
            renameGlobals: false,
            // Reduce size impact
            simplify: true,
            splitStrings: true,
            splitStringsChunkLength: 20,
          });
          chunk.code = result.getObfuscatedCode();
        }
      }
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss(), obfuscatePlugin()],

  define: {
    __APP_EDITION__: JSON.stringify(edition),
    __APP_NAME__: JSON.stringify(edition === 'alpha' ? 'Little Claude Alpha' : 'Little Claude'),
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available.
  // NOTE: 1420 is often blocked on Windows (Hyper-V/WSL excluded range 1360-1459).
  // 14200 also falls in WinNAT excluded range 14129-14228, so use 15200.
  server: {
    port: 15200,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 15201,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  // Code splitting: split heavy vendor libraries into separate chunks so the
  // main thread isn't blocked parsing a single 2.6 MB bundle at startup.
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-tiptap': ['@tiptap/react', '@tiptap/starter-kit', '@tiptap/extension-placeholder'],
          'vendor-codemirror': ['@codemirror/view', '@codemirror/state', '@codemirror/lang-javascript', '@codemirror/lang-html', '@codemirror/lang-css', '@codemirror/lang-json', '@codemirror/lang-markdown'],
          'vendor-markdown': ['react-markdown', 'rehype-highlight', 'remark-gfm'],
        },
      },
    },
  },
}));
