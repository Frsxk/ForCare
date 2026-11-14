"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { asApiError, type ApiError } from "@/lib/api/client";
import type { RegistrationInput } from "@/lib/api/contracts";
import { useSession } from "@/components/session-provider";
import { AuthBrandWordmark } from "./auth-brand-wordmark";
import "./auth-pages.css";

function BrandArtwork() {
  return <aside className="auth-art-panel">
    <AuthBrandWordmark/>
    <div className="auth-illustration"><Image src="/images/forcare-logo.png" alt="" width={400} height={437} priority /></div>
    <div className="auth-art-copy"><h2>Perawatan lanjutan,<br/>tetap hangat di rumah.</h2><p>Hubungkan pasien dan perawat setelah keluar dari rumah sakit.</p></div>
  </aside>;
}

export function AuthShell({ children }: { children: ReactNode }) {
  return <main className="auth-layout"><BrandArtwork/><section className="auth-form-panel">{children}</section></main>;
}

function clearPassword(form: HTMLFormElement | null) {
  const password = form?.elements.namedItem("password");
  if (password instanceof HTMLInputElement) password.value = "";
}

function useAuthForm() {
  const formRef = useRef<HTMLFormElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  useEffect(() => {
    const form = formRef.current;
    const request = requestRef;
    return () => {
      clearPassword(form);
      request.current?.abort();
    };
  }, []);
  return { formRef, requestRef, pending, setPending, error, setError };
}

export function LoginPage() {
  const { controller } = useSession();
  const { formRef, requestRef, pending, setPending, error, setError } = useAuthForm();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (requestRef.current) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const abort = new AbortController();
    requestRef.current = abort;
    setPending(true);
    setError(null);
    try {
      await controller.login({ email: String(fields.get("email") ?? ""), password: String(fields.get("password") ?? "") }, abort.signal);
    } catch (failure) {
      if (!abort.signal.aborted) setError(asApiError(failure));
    } finally {
      clearPassword(form);
      requestRef.current = null;
      if (!abort.signal.aborted) setPending(false);
    }
  }
  return <AuthShell><div className="auth-form-wrap"><header className="auth-heading"><h1>Masuk ke ForCare</h1><p id="login-help">Gunakan akun Anda. Akses perawat mengikuti akun yang telah diverifikasi.</p></header><form ref={formRef} className="auth-form" onSubmit={submit} aria-busy={pending} aria-describedby={error ? "login-help login-error" : "login-help"}>
    <label htmlFor="login-email">Email<input id="login-email" type="email" name="email" autoComplete="username" maxLength={254} placeholder="nama@email.com" required disabled={pending}/></label>
    <label htmlFor="login-password">Kata sandi<input id="login-password" type="password" name="password" autoComplete="current-password" maxLength={128} placeholder="Masukkan kata sandi" required disabled={pending}/></label>
    <button className="auth-submit" type="submit" disabled={pending}>{pending ? "Memeriksa akun…" : "Masuk"}</button>
    {error && <p id="login-error" role="alert">{error.message}</p>}
    <p className="auth-notice" role="status" aria-live="polite">{pending ? "Sedang memverifikasi sesi Anda." : ""}</p>
  </form><p className="auth-switch">Belum punya akun? <Link href="/daftar">Daftar</Link></p></div></AuthShell>;
}

export function RegisterPage() {
  const { controller } = useSession();
  const { formRef, requestRef, pending, setPending, error, setError } = useAuthForm();
  const [uncertain, setUncertain] = useState(() => controller.isRegistrationUncertain());
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (requestRef.current || controller.isRegistrationUncertain()) return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const gender = fields.get("gender");
    if (gender !== "male" && gender !== "female" && gender !== "other" && gender !== "undisclosed") return;
    const input: RegistrationInput = {
      fullName: String(fields.get("fullName") ?? ""), birthDate: String(fields.get("birthDate") ?? ""), gender,
      email: String(fields.get("email") ?? ""), phone: String(fields.get("phone") ?? ""), password: String(fields.get("password") ?? ""),
    };
    const abort = new AbortController();
    requestRef.current = abort;
    setPending(true);
    setError(null);
    try {
      await controller.register(input, abort.signal);
    } catch (failure) {
      if (!abort.signal.aborted) {
        setUncertain(controller.isRegistrationUncertain());
        setError(asApiError(failure));
      }
    } finally {
      input.password = "";
      clearPassword(form);
      requestRef.current = null;
      if (!abort.signal.aborted) setPending(false);
    }
  }
  const disabled = pending || uncertain;
  return <AuthShell><div className="auth-form-wrap register-wrap"><header className="auth-heading"><h1>Buat akun ForCare</h1><p id="register-help">Lengkapi data Anda untuk mendaftar sebagai pasien.</p></header><form ref={formRef} className="auth-form register-form" onSubmit={submit} aria-busy={pending} aria-describedby={error || uncertain ? "register-help register-error" : "register-help"}>
    <label className="auth-full" htmlFor="register-name">Nama lengkap<input id="register-name" name="fullName" autoComplete="name" maxLength={200} placeholder="Nama sesuai identitas" required disabled={disabled}/></label>
    <div className="auth-fields-row"><label htmlFor="register-birthdate">Tanggal lahir<input id="register-birthdate" type="date" name="birthDate" autoComplete="bday" required disabled={disabled}/></label><label htmlFor="register-gender">Jenis kelamin<select id="register-gender" name="gender" defaultValue="" required disabled={disabled}><option value="" disabled>Pilih</option><option value="female">Perempuan</option><option value="male">Laki-laki</option><option value="other">Lainnya</option><option value="undisclosed">Tidak ingin menyebutkan</option></select></label></div>
    <label className="auth-full" htmlFor="register-email">Email<input id="register-email" type="email" name="email" autoComplete="email" maxLength={254} placeholder="nama@email.com" required disabled={disabled}/></label>
    <label className="auth-full" htmlFor="register-phone">Nomor telepon<input id="register-phone" type="tel" name="phone" autoComplete="tel" minLength={3} maxLength={32} placeholder="0812-0000-0000" required disabled={disabled}/></label>
    <label className="auth-full" htmlFor="register-password">Kata sandi<input id="register-password" type="password" name="password" autoComplete="new-password" minLength={8} maxLength={128} placeholder="Minimal 8 karakter" required disabled={disabled}/></label>
    <button className="auth-submit auth-full" type="submit" disabled={disabled}>{pending ? "Memproses pendaftaran…" : "Daftar"}</button>
    {(error || uncertain) && <div id="register-error" className="auth-full" role="alert">{uncertain ? "Hasil pendaftaran belum dapat dipastikan. Akun mungkin sudah dibuat. Jangan kirim pendaftaran lagi; periksa sesi atau coba masuk dengan akun Anda." : error?.message}{uncertain && <p><button className="text-button" type="button" onClick={() => void controller.refresh()}>Periksa sesi lagi</button></p>}</div>}
    <p className="auth-notice auth-full" role="status" aria-live="polite">{pending ? "Menunggu konfirmasi pendaftaran dan sesi dari server." : ""}</p>
  </form><p className="auth-switch">Sudah punya akun? <Link href="/login">Masuk</Link></p></div></AuthShell>;
}
