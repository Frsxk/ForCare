export type HomecareRequestDetail = {
  submittedAt: string;
  identity: {
    ageAndSex: string;
    dischargedAt: string;
    phone: string;
  };
  screening: {
    chiefComplaint: string;
    bloodPressure: string;
    bodyTemperature: string;
    heartRate: string;
    consciousness: string;
    dailyCondition: string;
    physicalCondition: string;
  };
  risk: {
    level: "medium" | "unknown";
    label: string;
    chiefComplaint: string;
    vitalNote: string;
  };
  requestedDate: string;
  requestedTime: string;
};

// Data contoh mengikuti PNG. Informasi pasien lain menunggu integrasi backend.
const unavailableDetail = {
  submittedAt: "Belum tersedia",
  identity: {
    ageAndSex: "Belum tersedia",
    dischargedAt: "Belum tersedia",
    phone: "Belum tersedia",
  },
  screening: {
    chiefComplaint: "Belum tersedia",
    bloodPressure: "Belum tersedia",
    bodyTemperature: "Belum tersedia",
    heartRate: "Belum tersedia",
    consciousness: "Belum tersedia",
    dailyCondition: "Belum tersedia",
    physicalCondition: "Belum tersedia",
  },
  risk: {
    level: "unknown" as const,
    label: "Belum tersedia",
    chiefComplaint: "Belum tersedia",
    vitalNote: "Belum tersedia",
  },
};

export const homecareRequestDetails: Record<string, HomecareRequestDetail> = {
  "HC-0014": {
    submittedAt: "12 Nov 2026 · 09.15",
    identity: {
      ageAndSex: "36 tahun / Laki-laki",
      dischargedAt: "8 Nov 2026",
      phone: "0812–0000–0001",
    },
    screening: {
      chiefComplaint: "Badan terasa lemas sejak dua hari terakhir.",
      bloodPressure: "120/80 mmHg",
      bodyTemperature: "36,8 °C",
      heartRate: "78 bpm",
      consciousness: "Sadar penuh",
      dailyCondition: "Kondisi cukup stabil, nafsu makan menurun.",
      physicalCondition: "Lemas",
    },
    risk: {
      level: "medium",
      label: "Risiko sedang",
      chiefComplaint: "badan lemas dua hari, nafsu makan menurun",
      vitalNote: "[dibandingkan dengan batas yang ditetapkan tim klinis]",
    },
    requestedDate: "Senin, 16 November 2026",
    requestedTime: "10.00 WIB",
  },
  "HC-0015": {
    ...unavailableDetail,
    requestedDate: "Jumat, 13 November 2026",
    requestedTime: "13.00 WIB",
  },
  "HC-0013": {
    ...unavailableDetail,
    requestedDate: "Sabtu, 14 November 2026",
    requestedTime: "09.00 WIB",
  },
  "HC-0012": {
    ...unavailableDetail,
    requestedDate: "Kamis, 12 November 2026",
    requestedTime: "09.00 WIB",
  },
};
