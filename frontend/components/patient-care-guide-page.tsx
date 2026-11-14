"use client";

import { useId, useState } from "react";
import { Pill, BellRing, LockKeyhole, HeartPulse, Utensils, Footprints, TriangleAlert, ChevronDown } from "lucide-react";
import "./patient-care-guide-page.css";

export const guideCategories = ["Obat", "Perawatan luka", "Makan & minum", "Aktivitas", "Gejala bahaya"] as const;
export type GuideCategory = typeof guideCategories[number];
const guides: Record<GuideCategory, { icon: typeof Pill; sections: { title: string; points: string[] }[] }> = {
  "Obat":{icon:Pill,sections:[{title:"Panduan konsumsi obat",points:["Minum obat sesuai nama, dosis, dan waktu pada resep dokter.","Dosis mengikuti resep. Tanyakan kepada perawat sebelum mengubah jadwal atau dosis.","Laporkan keteraturan minum obat melalui Check-in Harian."]},{title:"Pengingat minum obat",points:["Ikuti jadwal minum obat yang tercantum pada resep dokter.","Catat keteraturan minum obat melalui Check-in Harian.","Jika dosis terlewat, ikuti petunjuk pada resep atau tanyakan kepada perawat."]},{title:"Instruksi penyimpanan obat",points:["Simpan obat sesuai petunjuk pada kemasan atau resep.","Jauhkan obat dari jangkauan anak-anak.","Periksa label obat sebelum digunakan."]}]},
  "Perawatan luka":{icon:HeartPulse,sections:[{title:"Menjaga area luka",points:["Ikuti jadwal dan cara perawatan luka yang sudah diberikan dokter atau perawat.","Jaga area sekitar luka tetap bersih dan kering sesuai instruksi perawatan.","Hindari mengoleskan produk lain tanpa arahan tenaga kesehatan."]},{title:"Mengganti balutan",points:["Gunakan perlengkapan yang dianjurkan tenaga kesehatan.","Cuci tangan sebelum dan sesudah melakukan perawatan.","Hubungi perawat bila Anda tidak yakin cara mengganti balutan."]},{title:"Pantau perubahan",points:["Perhatikan perubahan kondisi luka dan sampaikan kepada perawat saat check-in.","Bila kondisi memburuk atau muncul keluhan baru, hubungi tenaga kesehatan."]}]},
  "Makan & minum":{icon:Utensils,sections:[{title:"Panduan makan dan minum",points:["Ikuti anjuran makan dan minum yang diberikan dokter atau ahli gizi.","Catat perubahan nafsu makan atau keluhan saat makan pada check-in harian.","Tanyakan kepada tenaga kesehatan bila memiliki pantangan atau kebutuhan khusus."]},{title:"Membantu menjaga asupan",points:["Pilih waktu makan yang nyaman dan ikuti rencana makan Anda.","Sampaikan kepada perawat jika asupan makan atau minum berkurang."]}]},
  "Aktivitas":{icon:Footprints,sections:[{title:"Aktivitas di rumah",points:["Lakukan aktivitas sesuai kemampuan dan anjuran dokter.","Beristirahat bila merasa lelah atau tidak nyaman.","Mintalah bantuan keluarga bila membutuhkan pendampingan."]},{title:"Jadwal istirahat",points:["Ikuti jadwal istirahat yang membantu pemulihan Anda.","Sampaikan kepada perawat jika aktivitas sehari-hari terasa lebih sulit."]}]},
  "Gejala bahaya":{icon:TriangleAlert,sections:[{title:"Kapan perlu segera mencari bantuan",points:["Hubungi tenaga kesehatan jika kondisi terasa memburuk atau muncul keluhan yang mengkhawatirkan.","Untuk keadaan darurat, segera hubungi layanan darurat setempat atau pergi ke fasilitas kesehatan terdekat.","Jangan menunda mencari bantuan ketika Anda merasa keselamatan terancam."]},{title:"Informasi yang perlu disampaikan",points:["Sampaikan keluhan yang dirasakan, kapan keluhan mulai muncul, dan perubahan kondisi.","Siapkan daftar obat yang sedang dikonsumsi bila tersedia.","Minta keluarga menemani saat menghubungi tenaga kesehatan."]}]}
};

export function GeneralCareGuide({ category }: { category: GuideCategory }) {
  return <GeneralCareGuideSections key={category} category={category} />;
}

function GeneralCareGuideSections({ category }: { category: GuideCategory }) {
  const [expanded, setExpanded] = useState<number | null>(0);
  const id = useId();
  const active = guides[category];
  const Icon = active.icon;

  return (
    <section className="care-guide-general" aria-label={`Panduan umum: ${category}`}>
      {active.sections.map((section, index) => {
        const open = expanded === index;
        const triggerId = `${id}-trigger-${index}`;
        const panelId = `${id}-panel-${index}`;
        return (
          <article className={`care-guide-section${open ? " open" : ""}`} key={section.title}>
            <button
              type="button"
              className="care-guide-toggle"
              id={triggerId}
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setExpanded(open ? null : index)}
            >
              <span className="care-guide-icon" aria-hidden="true">
                {index === 0 ? <Icon size={20} /> : index === 1 ? <BellRing size={20} /> : <LockKeyhole size={20} />}
              </span>
              <strong>{section.title}</strong>
              <ChevronDown className="care-guide-chevron" size={18} aria-hidden="true" />
            </button>
            <div id={panelId} role="region" aria-labelledby={triggerId} hidden={!open}>
              <ul>{section.points.map(point => <li key={point}>{point}</li>)}</ul>
            </div>
          </article>
        );
      })}
    </section>
  );
}
