"use client";

import Link from "next/link";
import Image from "next/image";
import { useState, type FormEvent, type ReactNode } from "react";
import "./auth-pages.css";

function BrandArtwork() {
  return <aside className="auth-art-panel">
    <Link href="/login" className="auth-brand" aria-label="ForCare"><Image src="/forcare-brand.png" alt="ForCare" width={215} height={68} priority /></Link>
    <div className="auth-illustration"><Image src="/forcare-logo.png" alt="" width={400} height={437} priority /></div>
    <div className="auth-art-copy"><h2>Perawatan lanjutan,<br/>tetap hangat di rumah.</h2><p>Hubungkan pasien dan perawat setelah keluar dari rumah sakit.</p></div>
  </aside>;
}

function AuthShell({ children }: { children: ReactNode }) {
  return <main className="auth-layout"><BrandArtwork/><section className="auth-form-panel">{children}</section></main>;
}

export function LoginPage() {
  const [notice, setNotice] = useState("");
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setNotice("Form siap. Hubungkan autentikasi saat backend tersedia."); }
  return <AuthShell><div className="auth-form-wrap"><header className="auth-heading"><h1>Masuk ke ForCare</h1><p>Pilih peran Anda lalu masuk.</p></header><form className="auth-form" onSubmit={submit}>
    <label>Email<input type="email" name="email" autoComplete="email" placeholder="nama@email.com" required/></label>
    <label>Kata sandi<input type="password" name="password" autoComplete="current-password" placeholder="Masukkan kata sandi" required/></label>
    <button className="auth-submit" type="submit">Masuk</button>{notice && <p className="auth-notice" role="status">{notice}</p>}
  </form><p className="auth-switch">Belum punya akun? <Link href="/daftar">Daftar</Link></p></div></AuthShell>;
}

export function RegisterPage() {
  const [notice, setNotice] = useState("");
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setNotice("Data siap. Pendaftaran akan diproses saat backend tersedia."); }
  return <AuthShell><div className="auth-form-wrap register-wrap"><header className="auth-heading"><h1>Buat akun ForCare</h1><p>Lengkapi data Anda.</p></header><form className="auth-form register-form" onSubmit={submit}>
    <label className="auth-full">Nama lengkap<input name="name" autoComplete="name" placeholder="Nama sesuai identitas" required/></label>
    <div className="auth-fields-row"><label>Tanggal lahir<input type="date" name="birthDate" autoComplete="bday" required/></label><label>Jenis kelamin<select name="gender" defaultValue="" required><option value="" disabled>Pilih</option><option value="perempuan">Perempuan</option><option value="laki-laki">Laki-laki</option></select></label></div>
    <label className="auth-full">Email<input type="email" name="email" autoComplete="email" placeholder="nama@email.com" required/></label>
    <label className="auth-full">Nomor telepon<input type="tel" name="phone" autoComplete="tel" placeholder="0812-0000-0000" required/></label>
    <label className="auth-full">Kata sandi<input type="password" name="password" autoComplete="new-password" minLength={8} placeholder="Minimal 8 karakter" required/></label>
    <button className="auth-submit auth-full" type="submit">Daftar</button>{notice && <p className="auth-notice auth-full" role="status">{notice}</p>}
  </form><p className="auth-switch">Sudah punya akun? <Link href="/login">Masuk</Link></p></div></AuthShell>;
}
