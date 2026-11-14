"use client";

import type { ReactNode } from "react";
import { AuthShell } from "@/components/auth-pages";

export { LoginPage } from "@/components/auth-pages";

export function AuthPanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <AuthShell>
      <section className="auth-form-wrap" aria-labelledby="auth-title">
        <header className="auth-heading"><h1 id="auth-title">{title}</h1></header>
        {children}
      </section>
    </AuthShell>
  );
}
