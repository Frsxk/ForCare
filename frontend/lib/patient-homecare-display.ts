import type { BookingStatus } from "./api/homecare";

export const patientBookingStatusLabels: Record<BookingStatus, string> = {
  draft: "Draf",
  submitted: "Menunggu konfirmasi",
  accepted: "Diterima",
  rejected: "Ditolak",
  cancelled: "Dibatalkan",
};

const eventLabels: Record<string, string> = {
  "booking.created": "Draf pengajuan dibuat",
  "booking.updated": "Draf pengajuan diperbarui",
  "booking.submitted": "Pengajuan terkirim",
  "booking.accepted": "Pengajuan diterima perawat",
  "booking.rejected": "Pengajuan ditolak perawat",
  "booking.cancelled": "Pengajuan dibatalkan",
  "booking.rescheduled": "Jadwal kunjungan diubah",
};

export function patientBookingEventLabel(action: string) {
  return eventLabels[action] ?? "Aktivitas pengajuan";
}

export function formatPatientDate(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("id-ID", {
    weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone,
  }).format(new Date(value));
}

export function formatPatientTime(value: string, timeZone: string) {
  return new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone,
  }).format(new Date(value));
}

export function formatPatientDateTime(value: string, timeZone: string) {
  const clock = new Intl.DateTimeFormat("id-ID", {
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZoneName: "short", timeZone,
  }).format(new Date(value));
  return `${formatPatientDate(value, timeZone)} · ${clock}`;
}
