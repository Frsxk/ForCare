"use client";
import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { Bell, Menu, X } from "lucide-react";
import { useNurseProfile } from "@/components/nurse-workspace-provider";
import { Avatar } from "@/components/patient-identity";
import { AccountPopover } from "@/components/account-popover";
export function NurseHeader({
  activePage,
}: {
  activePage: "dashboard" | "requests" | "visits" | "patients" | "profile" | "notifications";
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const profile = useNurseProfile();
  const name = profile.status === "ready" ? profile.data.displayName : "Profil perawat";
  const staffCode = profile.status === "ready" ? profile.data.staffCode : profile.status === "error" ? "Profil belum dapat dimuat" : "Memuat profil…";
  const initials = profile.status === "ready" ? name.split(/\s+/).slice(0, 2).map(part => part[0]).join("") : "";
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
            <Image src="/images/forcare-brand.png" alt="ForCare" width={215} height={68} priority />
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
            <AccountPopover
              name={name}
              detail={staffCode}
              profileHref="/profil"
              className={`profile-button${activePage === "profile" ? " is-active" : ""}`}
            >
              <Avatar initials={initials} nurse />
              <span className="profile-copy">
                <strong>{name}</strong>
                <span>{staffCode}</span>
              </span>
            </AccountPopover>
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
