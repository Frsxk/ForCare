"use client";

import type { FunctionComponent, ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { NurseWorkspaceProvider } from "@/components/nurse-workspace-provider";
import { PatientWorkspaceProvider } from "@/components/patient-workspace-provider";
import { AuthPanel, LoginPage } from "@/components/login-page";
import { RegisterPage } from "@/components/auth-pages";
import { SessionActions } from "@/components/session-actions";
import { useSession } from "@/components/session-provider";
import { canUseNurseWorkspace } from "@/lib/api/contracts";

export const AuthBoundary: FunctionComponent<{ children: ReactNode }> = ({ children }) => {
  const { state, controller } = useSession();
  const pathname = usePathname();
  if (state.status === "checking") {
    return <AuthPanel title="Memeriksa sesi"><p role="status" aria-live="polite">Mohon tunggu. Data akun sedang diperiksa.</p></AuthPanel>;
  }
  if (state.status === "anonymous") return pathname === "/daftar" ? <RegisterPage /> : <LoginPage />;
  if (state.status === "error") {
    return (
      <AuthPanel title="Sesi belum dapat diperiksa">
        <p role="alert">{state.error.message}</p>
        <button className="button button-primary" onClick={() => void controller.refresh()}>Periksa sesi lagi</button>
        <p><Link href="/login">Kembali ke halaman masuk</Link></p>
      </AuthPanel>
    );
  }
  const nurse = canUseNurseWorkspace(state.session);
  const patient = state.session.account.roles.length === 1 && state.session.account.roles[0] === "patient" && state.session.access.scopes.includes("patient:self");
  const patientRoute = pathname === "/pasien" || pathname?.startsWith("/pasien/");
  const nurseRoute = pathname === "/" || ["/pengajuan-homecare", "/jadwal-kunjungan", "/pasien-rekam-medis", "/pemantauan-risiko", "/notifikasi", "/profil"].some(route => pathname === route || pathname?.startsWith(`${route}/`));
  const workspaceKey = JSON.stringify([state.session.account.id, state.session.session.csrfToken, state.session.account.roles, state.session.access.scopes]);
  if (state.loggingOut) return <AuthPanel title="Mengakhiri sesi"><p role="status">Menunggu konfirmasi keluar dari server.</p><SessionActions /></AuthPanel>;
  if (state.logoutError) return <AuthPanel title="Sesi perlu diperiksa"><p>Data ruang kerja disembunyikan sampai sesi diperiksa kembali.</p><SessionActions /></AuthPanel>;
  if (patient && patientRoute) {
    return <PatientWorkspaceProvider key={workspaceKey}>{children}</PatientWorkspaceProvider>;
  }
  if (nurse && nurseRoute) {
    return <NurseWorkspaceProvider key={workspaceKey}>{children}</NurseWorkspaceProvider>;
  }
  return (
    <AuthPanel title="Anda sudah masuk">
      <p>{nurse ? "Akun perawat terverifikasi. Halaman ini bukan ruang kerja perawat." : patient ? "Anda menggunakan akun pasien. Halaman ini belum terhubung ke ruang kerja pasien. Ruang kerja perawat tidak tersedia untuk akun ini." : "Akses ruang kerja perawat belum diberikan."}</p>
      {nurse ? <p><Link className="button button-primary" href="/">Buka beranda perawat</Link></p> : patient ? <p><Link className="button button-primary" href="/pasien">Buka beranda pasien</Link></p> : <p>Layanan untuk akun ini belum terhubung. Data ruang kerja tidak ditampilkan.</p>}
      <SessionActions />
    </AuthPanel>
  );
};
