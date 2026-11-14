import { Suspense } from "react";
import type { Metadata } from "next";
import { SessionProvider } from "@/components/session-provider";
import { AuthBoundary } from "@/components/auth-boundary";
import "@fontsource/lato/latin-400.css";
import "@fontsource/lato/latin-700.css";
import "@fontsource/fredoka/latin-600.css";
import "@fontsource/plus-jakarta-sans/latin-700.css";
import "@fontsource/plus-jakarta-sans/latin-800.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "ForCare",
  description: "Masuk ke akun ForCare Anda.",
  icons: { icon: "/forcare-mark.svg" },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="id">
      <body>
        <SessionProvider>
          <Suspense fallback={<main className="demo-signout"><section className="demo-signout-card"><p role="status" aria-live="polite">Memuat ForCare…</p></section></main>}>
            <AuthBoundary>{children}</AuthBoundary>
          </Suspense>
        </SessionProvider>
      </body>
    </html>
  );
}
