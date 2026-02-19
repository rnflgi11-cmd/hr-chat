// src/app/layout.tsx
import "./globals.css";

export const metadata = {
  title: "코비전 HR 규정 챗봇",
  description: "사내 HR 규정 Q&A",
  manifest: "/manifest.webmanifest",
  themeColor: "#0b1220",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
