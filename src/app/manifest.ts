import type { MetadataRoute } from "next";
import { appConfig } from "@/app.config";
import { pwa } from "@/lib/pwa";

/** Makes the CRM installable: on a phone's home screen it opens full screen, like an app. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: pwa.name,
    short_name: pwa.shortName,
    description: appConfig.brand.description,
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    background_color: pwa.splash,
    theme_color: appConfig.theme.browserColor,
    categories: ["business", "productivity"],
    icons: [
      { src: "/icon/192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon/512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon/maskable", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Activities", url: "/activities" },
      { name: "Clients", url: "/clients" },
      { name: "People", url: "/people" },
    ],
  };
}
