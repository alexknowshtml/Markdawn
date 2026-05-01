import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const monorepoRoot = path.resolve(__dirname, "../../");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, monorepoRoot, "");

  return {
    envDir: monorepoRoot,
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        output: {
          manualChunks: (id) => {
            if (id.includes("node_modules")) {
              if (id.includes("@milkdown") || id.includes("prosemirror")) {
                return "editor";
              }
              if (id.includes("yjs") || id.includes("@hocuspocus")) {
                return "collab";
              }
              if (id.includes("@mantine")) {
                return "mantine";
              }
              if (id.includes("react") || id.includes("react-dom")) {
                return "react";
              }
            }
          },
        },
      },
    },
    server: {
      proxy: {
        "/api": {
          target: env.VITE_API_URL ?? "http://localhost:3001",
          changeOrigin: true,
        },
        "/collab": {
          target: "http://localhost:1234",
          ws: true,
          changeOrigin: true,
          rewrite: (path: string) => path.replace(/^\/collab/, ""),
        },
      },
    },
  };
});
