import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

// Opaque 180x180 — iOS fills transparency with black, so no rounded corners.
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#16a34a" }}>
        <svg width="180" height="180" viewBox="0 0 512 512">
          <path d="M292 48 L148 296 L244 296 L216 464 L368 216 L264 216 Z" fill="#ffffff" />
        </svg>
      </div>
    ),
    { ...size }
  );
}
