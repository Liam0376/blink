import { ImageResponse } from "next/og";

export const size = { width: 512, height: 512 };
export const contentType = "image/png";

// Full-bleed opaque icon (no rounded corners baked in — the OS masks).
// Vector bolt, not emoji: renders identically on every build machine.
export default function Icon() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#16a34a" }}>
        <svg width="512" height="512" viewBox="0 0 512 512">
          <path d="M292 48 L148 296 L244 296 L216 464 L368 216 L264 216 Z" fill="#ffffff" />
        </svg>
      </div>
    ),
    { ...size }
  );
}
