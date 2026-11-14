# ForCare — Frontend

Frontend Next.js App Router, React, TypeScript, dan Tailwind CSS untuk ruang kerja pasien dan perawat utama. Ikon menggunakan Lucide; font disajikan dari paket lokal Fontsource. Autentikasi sesi berbasis cookie dan data produk aktif diambil melalui API Elysia, bukan koleksi data mock.

Pasien dapat mendaftar sendiri, masuk/keluar, membaca profil dan panduan perawatan aktif, mengubah kontak, membuat/mengoreksi draf check-in, menyerahkan check-in secara eksplisit, serta melihat riwayat dan proyeksi analisis yang sudah dipublikasikan. Perawat diprovisikan melalui operasi operator, hanya membaca pasien dalam penugasannya, membuat/mengoreksi snapshot medis berversi, serta meninjau, merevisi, menyetujui, dan memublikasikan draf analisis melalui tindakan terpisah.

## Menjalankan secara lokal

Untuk demo native yang terisolasi dan dapat direproduksi, ikuti [panduan backend](../backend/README.md#reproducible-native-localhost-demo): Bun 1.4.2, PostgreSQL 16 sekali pakai pada `127.0.0.1:55432`, environment privat di luar repository, migrasi sebelum API/worker, serta langkah operator dan pembersihan yang hanya menargetkan container terpilih. Dokumen tersebut juga memisahkan mode ini dari Compose dan produksi. Root `.env.example` hanya template variabel, bukan environment demo lengkap atau sumber kredensial.

Default yang konsisten adalah frontend `http://localhost:3000` dan API `127.0.0.1:3001`. Setelah database dimigrasikan dan API dijalankan, jalankan dari folder `frontend`:

```sh
npm ci
npm run dev
```

`FORCARE_BACKEND_ORIGIN` menentukan origin API dan berdefault ke `http://127.0.0.1:3001`. Nilai harus berupa origin HTTP(S) tanpa kredensial, path, query, atau fragment. `next.config.ts` hanya mengarahkan permintaan same-origin `/api/v1/:path*` ke `/api/v1/:path*` pada backend; konfigurasi backend tidak diekspos sebagai variabel klien. Jika port API diubah, isi origin tersebut sebelum menjalankan Next.js. Untuk server produksi, nilai ini dipakai ketika `npm run build`; ubah port berarti build harus dijalankan ulang, bukan hanya `npm start`.

Untuk proses produksi:

```sh
npm run build
npm start
```

Deployment browser produksi wajib memakai HTTPS pada frontend dan origin tersebut harus tercantum persis dalam `AUTH_ALLOWED_ORIGINS`. Secara terpisah, mode native loopback untuk Chromium pada localhost menggunakan `HOST=127.0.0.1`, `AUTH_LOCAL_HTTP_TEST=true`, dan rewrite same-origin yang sudah ada. Defaultnya frontend `http://localhost:3000` dengan API `127.0.0.1:3001`; jika memakai `http://localhost:3400`, origin persis itu harus dicantumkan dalam `AUTH_ALLOWED_ORIGINS`. Atribut `Secure` dan `__Host-` cookie tetap tidak berubah. Dukungan ini terbatas pada Chromium di localhost, bukan jaminan untuk host HTTP sembarangan, browser lain, Compose, atau kompatibilitas browser umum. Lihat [panduan backend](../backend/README.md#reproducible-native-localhost-demo) untuk konfigurasi yang dapat direproduksi. HTTPS produksi tidak berubah.

Frontend tidak disertakan dalam Docker Compose. Worker analisis klinis juga proses backend terpisah; perintah `ai:smoke` hanya memeriksa konektivitas provider nonmedis dan tidak menggantikan worker tersebut.

## Route dan sesi

Route publik:

- `/daftar`: pendaftaran akun pasien; pendaftaran publik tidak membuat akun perawat.
- `/login`: autentikasi pasien atau perawat yang sudah diprovisikan. Server menetapkan cookie sesi; frontend memeriksa sesi dan mengarahkan pengguna ke ruang kerja sesuai perannya. Logout mengirim permintaan pengakhiran sesi ke server.

Ruang kerja pasien:

- `/pasien`: beranda dan ringkasan data pasien yang sedang masuk.
- `/pasien/profil`: profil, identitas, perawat utama, dan kontak yang dimiliki pasien.
- `/pasien/profil/kontak`: perubahan nomor telepon, alamat, nama, dan telepon kontak darurat melalui API.
- `/pasien/check-in`: pembuatan draf, koreksi berversi, penyerahan eksplisit, dan riwayat check-in. Draf belum dianggap sebagai laporan yang diserahkan.
- `/pasien/panduan`: instruksi perawatan aktif dan proyeksi analisis untuk pasien yang telah dipublikasikan. Draf, catatan internal, dan snapshot medis mentah tidak ditampilkan di sini.
- `/pasien/homecare`, `/pasien/homecare/pesan`, dan `/pasien/notifikasi`: halaman status layanan belum tersedia; tidak membuat pemesanan atau riwayat notifikasi palsu.

Ruang kerja perawat:

- `/`: beranda perawat dan daftar pasien dalam cakupan penugasan aktif.
- `/profil`: profil perawat dari server dan logout sesi.
- `/pasien-rekam-medis`: pencarian pasien yang ditugaskan kepada perawat tersebut.
- `/pasien-rekam-medis/[patientId]`: profil pasien, observasi, check-in yang diserahkan, panduan aktif, serta editor snapshot medis. Pembuatan snapshot dan koreksi penuh menghasilkan revisi immutable; kolom terstruktur memakai editor JSON tervalidasi dan waktu ditulis dalam UTC yang eksplisit.
- Panel analisis pada detail pasien membuat draf dari check-in yang telah diserahkan, memeriksa status pekerjaan, menampilkan rujukan bukti, serta mendukung revisi dan tinjauan perawat. Persetujuan tidak otomatis memublikasikan. Publikasi merupakan tindakan eksplisit setelah worker merekonsiliasi jeda tinjauan yang persisten.

## Integrasi API dan alur analisis

`components/session-provider.tsx` memegang sesi terverifikasi. Klien pada `lib/api/` memakai endpoint same-origin, menangani CSRF dan kunci idempotensi untuk mutasi, serta menjaga pembatalan dan isolasi hasil terlambat pada pergantian sesi. Snapshot dan tulisan analisis menggunakan pembacaan ulang ID yang tepat; keadaan tulis yang belum pasti tidak dianggap berhasil hanya karena halaman dimuat ulang.

Dokumentasi rute, otorisasi, CSRF, idempotensi, serta batas validasi berada di [referensi API](../backend/API.md). Provisikan perawat, kelola kredensial synthetic secara privat, serta tetapkan nomor rekam medis dan perawat utama melalui CLI terkontrol yang dijelaskan pada [panduan backend](../backend/README.md), bukan melalui route admin frontend.

Worker analisis berjalan terpisah dari API dan menggunakan PostgreSQL untuk jeda tinjauan yang dapat dipulihkan. Model utamanya Google `gemini-4-hydrogen`; `gemini-3.5-flash-lite` hanya dicoba setelah respons HTTP 429 numerik. Draf mengutip pengamatan/check-in, instruksi, atau potongan korpus yang disetujui. Worker tidak memublikasikan hasil dan tidak menghasilkan skor klinis. `bun run ai:smoke` hanyalah CLI konektivitas provider dengan prompt nonmedis, bukan pipeline draf klinis.

## Struktur utama

- `app/login`, `app/daftar`, `app/pasien`, dan route ruang kerja perawat: pembungkus route untuk komponen terautentikasi.
- `components/auth-pages.tsx`: pendaftaran dan login.
- `components/session-provider.tsx`: sesi cookie terverifikasi, identitas peran, dan logout.
- `components/patient-live-pages.tsx`: beranda, profil/kontak, check-in, serta panduan pasien.
- `components/nurse-workspace-provider.tsx`: pembacaan API dan isolasi sumber daya untuk ruang kerja perawat.
- `components/nurse-workspace-pages.tsx`: daftar/detail pasien penugasan, profil perawat, dan status route belum tersedia.
- `components/medical-snapshot-panel.tsx`: snapshot medis awal dan koreksi immutable berversi.
- `components/patient-analysis.tsx`: pembuatan draf, polling terbatas, revisi, tinjauan, persetujuan, dan publikasi terpisah.
- `lib/api/`: transport same-origin dan klien akun pasien, perawat, check-in, panduan, serta analisis.
- `lib/api/proxy.ts`: definisi satu rewrite `/api/v1/:path*` yang digunakan oleh `next.config.ts`.
- `app/globals.css` dan stylesheet komponen: tema, tata letak, serta breakpoint responsif.

Sejumlah komponen, provider, dan file data mock awal seperti `components/nurse-data-provider.tsx`, `lib/dashboard-data.ts`, dan `lib/visit-data.ts` dipertahankan sebagai sumber referensi yang tidak dipakai oleh route produk aktif. Isi file tersebut bukan indikator fitur yang tersedia, bukan penyimpanan runtime, dan bukan backend.

## Pemeriksaan

```sh
npm run build
npx tsc --noEmit
```

## Pasien dan rekam medis perawat

`/pasien-rekam-medis` menampilkan hasil API yang dibatasi oleh penugasan perawat aktif, bukan direktori enam pasien contoh. Pencarian memfilter nama/nomor rekam medis melalui layanan; nomor rekam medis dan perawat utama dipasangkan melalui CLI operator. Detail pasien hanya dapat diakses dalam cakupan yang diizinkan server.

Snapshot medis memuat referensi sumber, diagnosis, alergi, tindakan, keluhan, observasi, waktu masuk/pulang UTC, dan catatan internal sesuai kontrak. Koreksi adalah revisi penuh baru, bukan penyuntingan histori. Validasi format tidak menyimpulkan kondisi klinis atau mengisi default medis yang tidak ada di sumber. Check-in dan panduan aktif dibaca dari data pasien terkait.

## Pemantauan risiko

Route `/pemantauan-risiko` menampilkan status layanan belum tersedia. Penilaian dan skor risiko klinis numerik tidak diimplementasikan, dihitung frontend, atau disimpulkan dari draf AI. Persetujuan analisis hanya berlaku pada revisi draf tersebut dan tidak menjadi skor maupun publikasi otomatis.

## Profil perawat

Route `/profil` dibuka dari avatar/nama perawat pada header dan membaca identitas, kode staf, disiplin sumber, email, telepon, serta zona waktu tampilan dari sesi API yang aktif. Logout meminta server mengakhiri sesi cookie dan kembali ke login; ini bukan reset state demo lokal. Preferensi notifikasi dan hitungan belum dibaca dari mock awal bukan fitur ruang kerja aktif.

## Layanan yang belum tersedia

Route berikut secara eksplisit menampilkan status belum tersedia, bukan mensimulasikan layanan:

- `/pengajuan-homecare` dan `/pengajuan-homecare/[requestId]`: pengajuan serta keputusan homecare belum terhubung.
- `/jadwal-kunjungan` dan `/jadwal-kunjungan/[visitId]`: penjadwalan, kunjungan, dan formulir catatan kunjungan belum tersedia.
- `/notifikasi` dan `/pasien/notifikasi`: riwayat notifikasi, status baca, preferensi pengiriman, serta browser push belum tersedia.
- `/pemantauan-risiko`: skor dan penilaian risiko klinis belum tersedia.
- `/pasien/homecare` dan `/pasien/homecare/pesan`: pemesanan, pemilihan perawat, dan jadwal homecare belum tersedia.

Tidak ada keputusan pengajuan, jadwal kunjungan, skor, notifikasi, atau data risiko contoh yang boleh diperlakukan sebagai data produk langsung. Rujukan visual awal tidak mengubah batas implementasi ini.
