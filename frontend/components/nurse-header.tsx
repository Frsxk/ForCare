"use client";
import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { Bell, Menu, X } from "lucide-react";
import { nurse } from "@/lib/dashboard-data";
import { Avatar } from "@/components/patient-identity";
export function NurseHeader({
  activePage,
}: {
  activePage: "dashboard" | "requests" | "visits" | "patients" | "profile" | "notifications";
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <>
      <a className="skip-link" href="#konten-utama">
        Lewati ke konten utama
      </a>
      <header className="site-header">
        <div className="header-inner">
          <Link
            href="/"
            className="brand"
            aria-label="ForCare — Beranda perawat"
            onClick={() => {
              setMenuOpen(false);
            }}
          >
            <Image src="/forcare-brand.png" alt="ForCare" width={215} height={68} priority />
          </Link>

          <nav
            id="nurse-navigation"
            className={`main-nav${menuOpen ? " is-open" : ""}`}
            aria-label="Navigasi perawat"
          >
            <Link
              className={`nav-link${activePage === "dashboard" ? " is-active" : ""}`}
              href="/"
              aria-current={activePage === "dashboard" ? "page" : undefined}
              onClick={() => {
                  setMenuOpen(false);
              }}
            >
              Beranda
            </Link>
            <Link
              href="/pengajuan-homecare"
              className={`nav-link${activePage === "requests" ? " is-active" : ""}`}
              aria-current={activePage === "requests" ? "page" : undefined}
              onClick={() => setMenuOpen(false)}
            >
              Pengajuan Homecare
            </Link>
            <Link
              href="/jadwal-kunjungan"
              className={`nav-link${activePage === "visits" ? " is-active" : ""}`}
              aria-current={activePage === "visits" ? "page" : undefined}
              onClick={() => setMenuOpen(false)}
            >
              Jadwal Kunjungan
            </Link>
            <Link href="/pasien-rekam-medis" className={`nav-link${activePage === "patients" ? " is-active" : ""}`} aria-current={activePage === "patients" ? "page" : undefined} onClick={() => setMenuOpen(false)}>
              Pasien &amp; Rekam Medis
            </Link>
          </nav>

          <div className="header-actions">
            <Link
              href="/notifikasi"
              className={`notification-button${activePage === "notifications" ? " is-active" : ""}`}
              aria-label="Buka notifikasi"
              aria-current={activePage === "notifications" ? "page" : undefined}
              onClick={() => setMenuOpen(false)}
            >
              <Bell size={21} strokeWidth={1.6} aria-hidden="true" />
            </Link>
            <Link
              href="/profil"
              className={`profile-button${activePage === "profile" ? " is-active" : ""}`}
              aria-current={activePage === "profile" ? "page" : undefined}
              onClick={() => setMenuOpen(false)}
              aria-label={`Lihat profil ${nurse.name}`}
            >
              <Avatar initials={nurse.initials} nurse />
              <span className="profile-copy">
                <strong>{nurse.name}</strong>
                <span>{nurse.id}</span>
              </span>
            </Link>
            <button
              className="icon-button menu-toggle"
              aria-label={menuOpen ? "Tutup navigasi" : "Buka navigasi"}
              aria-expanded={menuOpen}
              aria-controls="nurse-navigation"
              onClick={() => setMenuOpen(!menuOpen)}
            >
              {menuOpen ? (
                <X size={23} aria-hidden="true" />
              ) : (
                <Menu size={23} aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
      </header>

    </>
  );
}
