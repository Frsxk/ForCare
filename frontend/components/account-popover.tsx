"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { SessionActions } from "@/components/session-actions";
import { useSession } from "@/components/session-provider";
import "./account-popover.css";

export function AccountPopover({ name, detail, profileHref, className, children }: {
  name: string;
  detail: string;
  profileHref: string;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const preview = useRef(false);
  const restoringFocus = useRef(false);
  const panelId = useId();
  const { state } = useSession();
  const logoutNeedsAttention = state.status === "authenticated" && (state.loggingOut || Boolean(state.logoutError));

  useEffect(() => {
    if (!open) return;
    function dismissOutside(event: Event) {
      if (event.target instanceof Node && !root.current?.contains(event.target)) {
        preview.current = false;
        setOpen(false);
      }
    }
    function dismissEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      preview.current = false;
      setOpen(false);
      restoringFocus.current = true;
      trigger.current?.focus();
      restoringFocus.current = false;
    }
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    document.addEventListener("keydown", dismissEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
      document.removeEventListener("keydown", dismissEscape);
    };
  }, [open]);

  return <div className="account-popover" ref={root}
    onPointerEnter={event => {
      if (event.pointerType !== "mouse" || !window.matchMedia("(hover: hover) and (pointer: fine)").matches || open) return;
      preview.current = true;
      setOpen(true);
    }}
    onPointerLeave={event => {
      if (event.pointerType !== "mouse" || !preview.current || logoutNeedsAttention || root.current?.contains(document.activeElement)) return;
      preview.current = false;
      setOpen(false);
    }}>
    <button ref={trigger} type="button" className={`account-popover-trigger${className ? ` ${className}` : ""}`}
      aria-label={`Akun ${name}`} aria-expanded={open} aria-controls={panelId}
      onFocus={event => {
        if (!restoringFocus.current && !open && event.currentTarget.matches(":focus-visible")) {
          preview.current = true;
          setOpen(true);
        }
      }}
      onPointerDown={event => {
        if (event.pointerType !== "mouse") preview.current = false;
      }}
      onClick={() => {
        if (preview.current) {
          preview.current = false;
          setOpen(true);
        } else {
          setOpen(!open);
        }
      }}>
      {children}
    </button>
    <div id={panelId} className="account-popover-panel" hidden={!open}>
      <div className="account-popover-identity"><strong>{name}</strong><span>{detail}</span></div>
      <Link className="account-popover-profile" href={profileHref} onClick={() => setOpen(false)}>Lihat profil</Link>
      <SessionActions />
    </div>
  </div>;
}
