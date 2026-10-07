import { ImageResponse } from "next/og";

// Maskable: full-bleed background with the bolt inside the ~72% safe zone.
export async function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#16a34a",
        }}
      >
        <svg width="340" height="340" viewBox="0 0 512 512">
          <path d="M292 48 L148 296 L244 296 L216 464 L368 216 L264 216 Z" fill="#ffffff" />
        </svg>
      </div>
    ),
    { width: 512, height: 512 }
  );
}
