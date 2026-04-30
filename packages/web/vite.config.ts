import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  return {
    plugins: [react(), tailwindcss()],
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
