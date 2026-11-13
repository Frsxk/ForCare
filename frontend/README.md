# ForCare — Frontend Perawat

Frontend perawat berdasarkan referensi Beranda, Pengajuan Homecare, Detail Pengajuan, Jadwal Kunjungan, dan Rekam Medis Kunjungan, menggunakan Next.js App Router, React, TypeScript, dan Tailwind CSS. Ikon menggunakan Lucide; font Lato dan Plus Jakarta Sans disajikan dari paket lokal Fontsource.

## Menjalankan secara lokal

Jalankan dari folder `frontend`:

```sh
npm ci
npm run dev
```

Buka [http://localhost:3000](http://localhost:3000). Halaman ini tidak memerlukan backend atau variabel lingkungan.

## Cakupan halaman

- Header ForCare, profil perawat, notifikasi, dan navigasi mobile.
- Statistik pasien, pengajuan menunggu, dan kunjungan hari ini.
- Tabel pasien yang perlu perhatian dengan tingkat risiko dan sumber data.
- Pengajuan terbaru, kunjungan hari ini, dan jadwal terdekat.
- Dialog detail pasien, pencarian pasien, serta simulasi penandaan sudah ditinjau.
- Halaman detail pengajuan berisi identitas pasien, screening dan anamnesis, ringkasan risiko, jadwal diminta, serta simulasi keputusan perawat.

Halaman yang tersedia:

- `/`: Beranda perawat.
- `/pengajuan-homecare`: daftar pengajuan, filter Semua/Menunggu/Diterima/Ditolak, dan pencarian nama atau nomor RM.
- `/pengajuan-homecare/[requestId]`: detail masing-masing pengajuan, misalnya `/pengajuan-homecare/HC-0014`. Tombol Tinjau di daftar dan Beranda membuka halaman ini. Penolakan membutuhkan alasan; pengajuan yang sudah diputuskan menampilkan hasil keputusan.
- `/jadwal-kunjungan`: tab Mendatang/Selesai/Semua, jadwal hari ini, jadwal mendatang, dan riwayat kunjungan. Tombol baris membuka data pasien atau halaman rekam medis.
- `/jadwal-kunjungan/[visitId]`: formulir rekam medis tiap kunjungan, misalnya `/jadwal-kunjungan/VIS-002` untuk Ilham. Berisi penanggung jawab, waktu, tanda vital, observasi, tindakan, log alat/bahan, kelengkapan catatan, serta referensi pasien. Simpan draf menerima catatan yang belum lengkap; penyelesaian memerlukan keempat bagian lengkap dan waktu selesai setelah waktu mulai. Kunjungan selesai tampil dalam mode baca.

Menu Pasien & Rekam Medis masih membuka dialog ringkasan; halaman terpisah dapat ditambahkan pada tahap selanjutnya.

## Data contoh dan integrasi

Semua nama, ID, tanggal, jadwal, dan ringkasan merupakan placeholder di `lib/dashboard-data.ts` dan `lib/homecare-request-details.ts`. Detail Ilham mengikuti PNG; informasi tambahan pasien lain menampilkan "Belum tersedia". Tanggal demo mengikuti referensi: 12 November 2026. Statistik dihitung dari koleksi data contoh tersebut.

Status pengajuan, kunjungan, draf, rekam medis, tinjauan pasien, dan notifikasi disimpan dalam context React yang dipakai bersama semua halaman. Keputusan pengajuan ikut memperbarui daftar pengajuan dan jumlah pengajuan menunggu di Beranda. Menyimpan draf tidak mengubah status kunjungan; menyelesaikan catatan memperbarui status dan hitungan selesai hari ini. State yang disimpan bertahan saat berpindah halaman melalui navigasi aplikasi dan kembali ke kondisi awal ketika halaman dimuat ulang. Belum ada panggilan API atau penyimpanan data ke backend.

Isi awal formulir Ilham mengikuti PNG dan menampilkan 4 dari 4 bagian lengkap. Validasi hanya memeriksa pengisian serta format data; tidak menilai kondisi klinis. Log alat/bahan dapat ditambah atau dihapus; jika tidak ada yang digunakan, pilih pernyataan "Tidak menggunakan alat atau bahan medis". Referensi pasien mengarah ke halaman detail rekam medis pasien.

Jadwal contoh berada di `lib/visit-data.ts`, dengan hari demo 12 November 2026. Tab Mendatang hanya menampilkan kunjungan terjadwal mulai hari demo. Selesai memfilter berdasarkan status, dan Semua mencakup riwayat. Kunjungan 17 November tetap terjadwal; kunjungan setelah hari demo tidak dapat diselesaikan. Satu kunjungan lampau ditambahkan sebagai data contoh untuk tab riwayat.

## Struktur utama

- `app/page.tsx`: halaman beranda.
- `components/nurse-dashboard.tsx`: komponen dashboard dan interaksi.
- `components/homecare-requests-page.tsx`: daftar pengajuan, pencarian, dan filter status.
- `app/pengajuan-homecare/[requestId]/page.tsx`: route detail dan penanganan nomor pengajuan yang tidak ditemukan.
- `components/homecare-request-detail-page.tsx`: tata letak detail pengajuan.
- `components/homecare-decision.tsx`: simulasi menerima atau menolak pengajuan.
- `components/visit-schedule-page.tsx`: jadwal, tab filter, dan tautan ke profil pasien.
- `app/jadwal-kunjungan/[visitId]/page.tsx`: route detail rekam medis dan penanganan kunjungan tidak ditemukan.
- `components/visit-record-page.tsx`: formulir dan mode baca rekam medis kunjungan.
- `components/visit-record.css`: tata letak dan tampilan formulir rekam medis.
- `components/patient-record-page.tsx`: empat tab detail rekam medis pasien.
- `components/nurse-header.tsx`: header dan navigasi bersama.
- `components/nurse-data-provider.tsx`: state contoh yang dipakai lintas halaman.
- `components/ui/modal.tsx`: dialog native dengan fokus terkurung dan dukungan Escape.
- `lib/dashboard-data.ts`: tipe dan data placeholder.
- `lib/homecare-request-details.ts`: data contoh identitas, screening, risiko, dan jadwal.
- `lib/visit-data.ts`: data jadwal dan pemformatan tanggal demo.
- `lib/visit-medical-record.ts`: tipe catatan, data contoh, dan pemeriksaan kelengkapan formulir.
- `app/globals.css`: tema, tata letak, dan breakpoint responsif.
- `public/forcare-mark.svg`: ikon ForCare yang dibuat mengikuti referensi.

## Pemeriksaan

```sh
npm run build
npx tsc --noEmit
```

## Pasien & Rekam Medis

Route `/pasien-rekam-medis` menampilkan enam pasien sesuai PNG. Pencarian nama/nomor RM dapat digabung dengan filter risiko. Pemantauan Risiko membuka halaman peninjauan risiko; tombol rekam medis membuka halaman detail pasien dengan empat tab. Data demografi, check-in, dan risiko adalah placeholder di `lib/patient-directory-data.ts`. Kunjungan berikutnya memakai state jadwal bersama.

## Pemantauan Risiko

Route `/pemantauan-risiko` mengikuti referensi PNG: statistik risiko, pencarian, pemilihan pasien, tingkat risiko, persetujuan perawat, dan akses rekam medis. Risiko awal merupakan placeholder; frontend tidak menghitung skor klinis. Pilihan radio belum mengubah risiko hingga disetujui. Persetujuan memperbarui statistik, daftar pasien, dan badge risiko Beranda melalui context bersama; state kembali ke data awal saat refresh. Draf AI awal tetap ditampilkan sebagai referensi.

## Profil perawat

Route `/profil` dibuka dari avatar/nama perawat pada header. Identitas menggunakan placeholder terpusat, jumlah pasien dan kunjungan memakai data bersama. Empat checkbox preferensi notifikasi langsung tersimpan di context saat diubah dan bertahan saat navigasi aplikasi. Preferensi belum terhubung ke layanan notifikasi; perubahan tidak menghapus notifikasi contoh yang sudah ada. Notifikasi dari profil dan header mengarah ke `/notifikasi`, dengan hitungan belum dibaca yang berasal dari item notifikasi bersama. Keluar mengakhiri sesi demo lokal, mereset state contoh, dan menampilkan tombol masuk kembali; belum ada autentikasi/backend. Refresh juga mengembalikan seluruh data contoh.

## Notifikasi

Route `/notifikasi` mengikuti PNG terbaru dengan enam item riwayat contoh, tiga di antaranya belum dibaca. Tab Semua, Pengajuan, Jadwal kunjungan, dan Rekam medis mendukung klik serta navigasi keyboard (panah, Home, End). Membuka item menandainya dibaca dan menuju detail pengajuan/kunjungan terkait. Tandai semua dibaca berlaku untuk seluruh kategori tanpa menghapus riwayat; hitungan pada Profil ikut berubah. State bertahan saat navigasi aplikasi dan kembali ke awal saat refresh/keluar demo. Isi notifikasi adalah rekaman kejadian contoh pada `lib/notification-data.ts`, sehingga teks riwayat tidak berubah ketika status pengajuan atau rekam medis kemudian diperbarui. Preferensi Profil mengatur state pilihan untuk integrasi mendatang, bukan menyaring riwayat notifikasi yang sudah ada. Belum ada API/push notifikasi.

## Detail rekam medis pasien

Route `/pasien-rekam-medis/[patientId]` tersedia untuk enam pasien; nomor tidak dikenal menampilkan 404. Empat tab mengikuti PNG dan mendukung navigasi keyboard. Riwayat medis dapat diedit, dibatalkan, atau disimpan (diagnosis utama, alergi, tindakan terakhir, dan tanggal valid wajib diisi; diagnosis sekunder opsional). Persetujuan penilaian menyimpan ringkasan dan memperbarui risiko bersama. Kembali ke draf AI hanya mengembalikan isi formulir; keputusan tersimpan baru diganti sesudah disetujui lagi. AI berupa placeholder tanpa panggilan model/API.

Profil lengkap dan tiga check-in Ilham mengikuti referensi; identitas pasien lain memakai data direktori dan informasi yang belum ada ditulis Belum tersedia. Riwayat perawatan mengambil kunjungan selesai dari context. Untuk Ilham yang belum memiliki kunjungan selesai, satu kartu contoh sesuai PNG ditampilkan sebagai data demo; setelah kunjungan Ilham diselesaikan, catatan aktual sesi menggantikannya. Contoh ini tidak mengubah status jadwal. Draf kunjungan belum dianggap selesai. Riwayat dan penilaian bertahan saat navigasi dan direset saat refresh/keluar demo. Tombol rekam medis pada direktori, pemantauan risiko, dan formulir kunjungan mengarah ke halaman detail ini.

Tombol Lihat pasien pada jadwal mendatang membuka `/pasien-rekam-medis/[patientId]?tab=profile`. Tab detail pasien mengikuti parameter `tab` (profile, medical, assessment, care), sehingga tautan profil selalu membuka Profil Pasien meskipun pengguna sebelumnya melihat tab lain. Akses langsung ke formulir kunjungan yang tanggalnya setelah hari demo dialihkan ke profil pasien.
