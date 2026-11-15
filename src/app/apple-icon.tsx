import { ImageResponse } from "next/og";
import { pwa } from "@/lib/pwa";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** The Home Screen icon on iPhone and iPad. Square: iOS rounds the corners itself. */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: pwa.background, color: pwa.foreground, fontSize: 104, fontWeight: 700, fontFamily: "sans-serif" }}>{pwa.letter}</div>
    ),
    size,
  );
}
