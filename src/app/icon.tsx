import { ImageResponse } from "next/og";
import { pwa } from "@/lib/pwa";

/**
 * The favicon and the installed app's icons: the brand's first letter on its
 * color. "maskable" fills the whole square for Android, which crops it to its
 * own shape; the letter stays inside the safe zone.
 */
export function generateImageMetadata() {
  return [
    { id: "32", size: { width: 32, height: 32 }, contentType: "image/png" },
    { id: "192", size: { width: 192, height: 192 }, contentType: "image/png" },
    { id: "512", size: { width: 512, height: 512 }, contentType: "image/png" },
    { id: "maskable", size: { width: 512, height: 512 }, contentType: "image/png" },
  ];
}

export default async function Icon({ id }: { id: Promise<string> }) {
  const which = await id;
  const size = which === "maskable" ? 512 : Number(which);
  const maskable = which === "maskable";
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: pwa.background,
          color: pwa.foreground,
          borderRadius: maskable ? 0 : size * 0.22,
          fontSize: size * (maskable ? 0.42 : 0.58),
          fontWeight: 700,
          fontFamily: "sans-serif",
        }}
      >
        {pwa.letter}
      </div>
    ),
    { width: size, height: size },
  );
}
