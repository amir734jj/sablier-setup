import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

const backend = "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [preact()],
  server: {
    proxy: {
      "/socket.io": { target: backend, ws: true },
      "/api": backend,
      "/health": backend,
      "/events": backend,
      "/session": backend,
    },
  },
});
