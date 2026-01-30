import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
VitePWA({
  registerType: "autoUpdate",
  includeAssets: [
    "icon-192.png",
    "icon-512.png",
    "apple-touch-icon.png"
  ],
  manifest: {
    name: "DJJK 단찍공",
    short_name: "단찍공",
    description: "단어장 찍고 공부하기",
    start_url: "/",
    display: "standalone",

    theme_color: "#FFEB00",       // 🔹 상단 바, 주소창
    background_color: "#FFEB00",  // 🔹 스플래시 배경

    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png"
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png"
      }
    ]
  }
})
  ]
});
