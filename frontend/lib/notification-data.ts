export const notificationSettings = [
  { id: "requests", label: "Pengajuan homecare baru", description: "Saat pasien mengirim pengajuan" },
  { id: "scheduleChanges", label: "Perubahan jadwal", description: "Saat jadwal kunjungan berubah" },
  { id: "visits", label: "Jadwal kunjungan", description: "Pengingat kunjungan hari ini" },
  { id: "records", label: "Pengingat rekam medis", description: "Saat rekam medis kunjungan belum diisi" },
] as const;

export type NotificationSetting = (typeof notificationSettings)[number]["id"];
export type NotificationPreferences = Record<NotificationSetting, boolean>;
export const initialNotificationPreferences: NotificationPreferences = {
  requests: true,
  scheduleChanges: true,
  visits: true,
  records: true,
};

export type NotificationCategory = "requests" | "visits" | "records";
export type NurseNotification = {
  id: string;
  category: NotificationCategory;
  title: string;
  description: string;
  timestamp: string;
  dateTime: string;
  href: string;
  read: boolean;
};

// Riwayat kejadian contoh mengikuti PNG; bukan hasil notifikasi backend.
export const initialNotifications: NurseNotification[] = [
  {
    id: "NTF-001", category: "requests", read: false,
    title: "Pengajuan baru HC-0014 dari Ilham Shahputra Hasim",
    description: "Permintaan kunjungan Senin, 16 Nov 2026 pukul 10.00. Menunggu konfirmasi Anda.",
    timestamp: "12 Nov · 09.15", dateTime: "2026-11-12T09:15:00+07:00", href: "/pengajuan-homecare/HC-0014",
  },
  {
    id: "NTF-002", category: "visits", read: false,
    title: "Kunjungan hari ini pukul 14.00",
    description: "Ilham Shahputra Hasim (RM-2026-001) · dr. Andini Pratama.",
    timestamp: "12 Nov · 08.00", dateTime: "2026-11-12T08:00:00+07:00", href: "/jadwal-kunjungan/VIS-002",
  },
  {
    id: "NTF-003", category: "records", read: false,
    title: "Rekam medis kunjungan belum diisi",
    description: "Kunjungan Damar Wicaksono pukul 09.00 hari ini sudah selesai. Lengkapi rekam medis kunjungan.",
    timestamp: "12 Nov · 08.00", dateTime: "2026-11-12T08:00:00+07:00", href: "/jadwal-kunjungan/VIS-001",
  },
  {
    id: "NTF-004", category: "visits", read: true,
    title: "Jadwal kunjungan berubah",
    description: "Kunjungan Elang Pratama dipindah ke hari ini pukul 16.00.",
    timestamp: "11 Nov · 19.00", dateTime: "2026-11-11T19:00:00+07:00", href: "/jadwal-kunjungan/VIS-003",
  },
  {
    id: "NTF-005", category: "requests", read: true,
    title: "Pengajuan HC-0013 dari Citra Lestari",
    description: "Permintaan kunjungan menunggu konfirmasi Anda.",
    timestamp: "11 Nov · 14.20", dateTime: "2026-11-11T14:20:00+07:00", href: "/pengajuan-homecare/HC-0013",
  },
  {
    id: "NTF-006", category: "records", read: true,
    title: "Rekam medis kunjungan tersimpan sebagai draf",
    description: "Draf rekam medis Elang Pratama belum diselesaikan.",
    timestamp: "8 Nov · 12.00", dateTime: "2026-11-08T12:00:00+07:00", href: "/jadwal-kunjungan/VIS-003",
  },
];
