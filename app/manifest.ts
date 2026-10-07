import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Blink — expenses in 3 seconds",
    short_name: "Blink",
    description: "Personal expense and income tracker. Your transactions stay only on this phone.",
    start_url: "/",
    display: "standalone",
    background_color: "#2e1065",
    theme_color: "#7c3aed",
    orientation: "portrait",
    categories: ["finance", "productivity"],
    icons: [
      { src: "/icon-192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/apple-icon", sizes: "180x180", type: "image/png", purpose: "any" },
    ],
  };
}
