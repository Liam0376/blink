import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import RegisterSW from "./RegisterSW";
import { THEME_KEY } from "@/lib/keys";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Blink — expenses in 3 seconds",
  description:
    "Personal expense and income tracker. Your transactions stay only on this phone.",
  applicationName: "Blink",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Blink",
  },
  formatDetection: {
    telephone: false,
  },
  manifest: "/manifest.webmanifest",
  icons: {
    icon: "/icon",
    apple: "/apple-icon",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#7c3aed",
};

// Set the theme class before first paint (avoids light→dark flash)
const themeInit = `(function(){try{var s=localStorage.getItem('${THEME_KEY}');var d=s?s==='1':(window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(d)document.documentElement.classList.add('dark')}catch(e){}})();`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
      <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body className="min-h-full flex flex-col" style={{ background: "var(--background)" }}>
        <RegisterSW />
        {children}
      </body>
    </html>
  );
}
