# ForCare — Frontend

Frontend Next.js App Router, React, TypeScript, dan Tailwind CSS untuk ruang kerja pasien dan perawat utama. Ikon menggunakan Lucide; font disajikan dari paket lokal Fontsource. Autentikasi sesi berbasis cookie dan data produk aktif diambil melalui API Elysia, bukan koleksi data mock.

Visual baseline: `be1814a378b9b8c09ea073fa3e67e04b7b7c2216`. Keep its layouts, component classes, styles, and assets when wiring APIs; presentation changes require owner approval. Authentication retains the text-only wordmark from `41057d3` and the female/male registration options from `b9ab6b3`. Live values replace sample values; unavailable services retain their page structure with explicit empty/unavailable states, never fabricated clinical data or simulated successful writes.

Owner-approved refinements: the care guide presents general educational advice in compact category accordions, with published patient-specific instructions and care notes only when available. General advice is not an individual prescription; medication schedules, appointment dates, and contact numbers are never invented. Guide reload controls appear only for failed requests. Patient and nurse navbar accounts open a profile/logout popover by hover, click/touch, or keyboard; Escape, outside interaction, and focus leaving dismiss it. Logout still uses the shared session controller and preserves uncertain-session recovery.

The patient home follows the approved Figma card layout: session-localized greeting/date, confirmed visit banner, four fixed check-in summary slots, compact patient facts, schedule, medication instructions, shortcuts, and booking progress. Unmeasured values and unavailable discharge/follow-up data remain explicit; complete measurements remain available in check-in history. Booking details use Indonesian event labels and session-localized date/time ranges, with accurate pending/terminal decisions, reasons, and expandable intake/audit/cancellation controls. No medication-taking action or notification delivery is simulated.

On `/pasien/check-in`, the latest-check-in sidebar card omits free-text notes. Saved-draft review and check-in history still show the stored notes.

Pasien dapat mendaftar sendiri, masuk/keluar, membaca profil dan panduan perawatan aktif, mengubah kontak, membuat/mengoreksi draf check-in, menyerahkan check-in secara eksplisit, serta melihat riwayat dan proyeksi analisis yang sudah dipublikasikan. Pada Stop 4 pasien juga dapat memilih perawat dari direktori aktif, memilih slot yang benar-benar tersedia untuk booking ordinary, mengisi draf skrining homecare, meminta pengecualian waktu secara manual, menyerahkan permintaan, membaca status/riwayat, dan membatalkan sebelum mulai.

Perawat diprovisikan melalui operasi operator, hanya membaca pasien dalam penugasannya, membuat/mengoreksi snapshot medis berversi, serta meninjau, merevisi, menyetujui, dan memublikasikan draf analisis melalui tindakan terpisah. Untuk homecare, setiap perawat menerbitkan ketersediaannya sendiri dan hanya menangani antrean yang memilihnya: menerima/menolak permintaan, membaca jadwal terkonfirmasi, membatalkan, atau menjadwalkan ulang dengan alasan serta persetujuan pasien. Persetujuan ketersediaan prioritas merupakan keputusan manual yang terpisah dari penyerahan dan penerimaan booking.

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
- `/pasien/homecare`: daftar dan detail booking milik pasien, status/riwayat transisi, alasan keputusan, jadwal terkonfirmasi, serta pembatalan sebelum mulai. Draf bersifat privat; `submitted` berarti menunggu keputusan perawat dan belum menjadi kunjungan terkonfirmasi. Hanya `accepted` yang membuat kunjungan terjadwal.
- `/pasien/homecare/pesan`: direktori perawat aktif dan slot kanonis, skrining lengkap, persetujuan eksplisit, simpan/buka/edit draf, penyerahan, serta alur waktu di luar slot dengan pernyataan prioritas. Data profil pasien hanya dibaca; alamat yang belum lengkap diperbaiki melalui editor kontak. Tidak ada pencarian NIK, nomor rekam medis palsu, inferensi risiko, atau janji respons kegawatdaruratan.
- `/pasien/notifikasi`: halaman status layanan belum tersedia; tidak membuat riwayat notifikasi palsu.

Ruang kerja perawat:

- `/`: beranda perawat dan daftar pasien dalam cakupan penugasan aktif.
- `/profil`: profil perawat dari server, pintasan ke jadwal/ketersediaan dan notifikasi, serta logout sesi.
- `/pasien-rekam-medis`: pencarian pasien yang ditugaskan kepada perawat tersebut.
- `/pasien-rekam-medis/[patientId]`: profil pasien, observasi, check-in yang diserahkan, panduan aktif, serta editor snapshot medis. Pembuatan snapshot dan koreksi penuh menghasilkan revisi immutable; kolom terstruktur memakai editor JSON tervalidasi dan waktu ditulis dalam UTC yang eksplisit.
- `/pengajuan-homecare`: antrean booking yang secara eksplisit memilih perawat aktif, filter status, pencarian nama/nomor rekam medis, dan paginasi. Draf privat pasien tidak pernah masuk antrean ini.
- `/pengajuan-homecare/[requestId]`: skrining yang diizinkan untuk permintaan aktif, keputusan menerima/menolak dengan alasan yang disyaratkan, serta tinjauan prioritas terpisah. Konflik penerimaan berarti booking belum terkonfirmasi dan tidak membocorkan identitas pasien pesaing. Setelah akses intake berakhir atau booking terminal, frontend hanya menampilkan proyeksi keputusan/riwayat minimal tanpa kontak maupun intake lama.
- `/jadwal-kunjungan`: kunjungan `accepted` milik perawat yang dipilih beserta nama/nomor rekam medis pasien dan interval yang aman ditampilkan. Perawat dapat membatalkan sebelum mulai atau menjadwalkan ulang sebelum waktu lama dan baru, dengan alasan dan atestasi persetujuan pasien. Reschedule mempertahankan perawat dan identitas kunjungan yang sama; tidak mengubah perawat utama pasien. Ketersediaan perawat adalah kapabilitas sisi server saja dan tidak diekspos melalui UI: zona waktu IANA, durasi slot/buffer, horizon efektif, jendela mingguan, dan slot UTC diisi eksplisit lewat operasi CLI/API terkontrol. Tidak ada jam produksi, zona waktu default, konversi waktu tebakan, atau slot otomatis. Tanpa konfigurasi, slot publik mempunyai `timeZone: null` dan daftar kosong; versi baru tidak menulis ulang booking yang sudah diterima.
- `/jadwal-kunjungan/[visitId]`: tetap halaman status layanan belum tersedia. Identitas scheduling pada Stop 4 bukan formulir catatan klinis, penyelesaian kunjungan, atau finalisasi rekam medis.
- Panel analisis pada detail pasien membuat draf dari check-in yang telah diserahkan, memeriksa status pekerjaan, menampilkan rujukan bukti, serta mendukung revisi dan tinjauan perawat. Persetujuan tidak otomatis memublikasikan. Publikasi merupakan tindakan eksplisit setelah worker merekonsiliasi jeda tinjauan yang persisten.

## Integrasi API dan alur analisis

`components/session-provider.tsx` memegang sesi terverifikasi. Klien pada `lib/api/` memakai endpoint same-origin, menangani CSRF dan kunci idempotensi untuk mutasi, serta menjaga pembatalan dan isolasi hasil terlambat pada pergantian sesi. Snapshot dan tulisan analisis menggunakan pembacaan ulang ID yang tepat; keadaan tulis yang belum pasti tidak dianggap berhasil hanya karena halaman dimuat ulang. Operasi homecare memakai registry penulisan per sesi/peran: payload serta kunci operasi yang belum pasti dipertahankan untuk retry eksplisit dan pembacaan ulang target yang sama, bukan pembuatan booking baru ataupun retry mutasi otomatis.

Dokumentasi rute, otorisasi, CSRF, idempotensi, serta batas validasi berada di [referensi API](../backend/API.md). Bentuk DTO dan aturan konfigurasi tidak diduplikasi di sini: lihat referensi [ketersediaan perawat berversi](../backend/API.md#versioned-nurse-availability), [booking dan jadwal perawat terpilih](../backend/API.md#bookings-and-selected-nurse-scheduling), serta [permintaan ketersediaan prioritas](../backend/API.md#priority-availability-requests). Migrasi dan setup database dijelaskan pada [panduan database](../backend/README.md#database-migrations-and-integration-tests). Provisikan perawat, kelola kredensial synthetic secara privat, serta tetapkan nomor rekam medis dan perawat utama melalui CLI terkontrol yang dijelaskan pada [operasi identitas](../backend/README.md#identity-operations), bukan melalui route admin frontend.

Booking, availability, keputusan, jadwal, dan pengecualian prioritas tidak memakai worker AI maupun model berbayar. Worker analisis hanya diperlukan untuk alur draf klinis yang independen; penghentian worker tidak mengubah penyimpanan maupun keputusan booking. Worker tersebut berjalan terpisah dari API dan menggunakan PostgreSQL untuk jeda tinjauan yang dapat dipulihkan. Model utamanya Google `gemini-3.5-flash`; `gemini-3.5-flash-lite` hanya dicoba setelah respons HTTP 429 numerik. Draf mengutip pengamatan/check-in, instruksi, atau potongan korpus yang disetujui. Worker tidak memublikasikan hasil dan tidak menghasilkan skor klinis. `bun run ai:smoke` hanyalah CLI konektivitas provider dengan prompt nonmedis, bukan pipeline draf klinis atau prasyarat booking.

## Struktur utama

- `app/login`, `app/daftar`, `app/pasien`, dan route ruang kerja perawat: pembungkus route untuk komponen terautentikasi.
- `components/auth-pages.tsx`: pendaftaran dan login.
- `components/session-provider.tsx`: sesi cookie terverifikasi, identitas peran, dan logout.
- `components/account-popover.tsx`: menu akun navbar pasien/perawat, tautan profil, dan logout melalui pengendali sesi yang sama.
- `components/patient-live-pages.tsx`: beranda, profil/kontak, check-in, serta panduan pasien.
- `components/patient-care-guide-page.tsx`: panduan umum edukatif per kategori, terpisah dari instruksi klinis pasien yang diterbitkan.
- `components/nurse-workspace-provider.tsx`: pembacaan API dan isolasi sumber daya untuk ruang kerja perawat.
- `components/nurse-workspace-pages.tsx`: daftar/detail pasien penugasan, profil perawat, dan status route belum tersedia.
- `components/homecare-patient.tsx`: riwayat pasien serta draf, skrining, pemilihan perawat/slot, pengajuan, pembatalan, dan prioritas.
- `components/homecare-nurse.tsx`: antrean/detail permintaan perawat terpilih, keputusan booking, tinjauan prioritas, editor ketersediaan, jadwal terkonfirmasi, pembatalan, dan reschedule dengan persetujuan pasien.
- `components/medical-snapshot-panel.tsx`: snapshot medis awal dan koreksi immutable berversi.
- `components/patient-analysis.tsx`: pembuatan draf, polling terbatas, revisi, tinjauan, persetujuan, dan publikasi terpisah.
- `lib/api/`: transport same-origin dan klien akun pasien, perawat, check-in, panduan, analisis, serta homecare.
- `lib/api/proxy.ts`: definisi satu rewrite `/api/v1/:path*` yang digunakan oleh `next.config.ts`.
- `lib/patient-homecare-display.ts`: label status/peristiwa pengajuan dan format tanggal/jam menurut zona waktu sesi pasien.
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

## Siklus booking dan batas konteks klinis

Siklus persisten adalah `draft` → `submitted` → `accepted` atau `rejected`; pasien maupun perawat terpilih dapat membuat status `cancelled` sebelum mulai dengan alasan. Draf dapat diedit dan dibatalkan. Penyerahan memerlukan persetujuan skrining serta profil kontak lengkap dan membekukan intake/snapshot profil yang dimiliki server. Beberapa permintaan dapat menunggu pada slot yang sama, tetapi hanya penerimaan yang mereservasi interval; batas maksimal tiga booking aktif dan pencegahan tumpang-tindih diberlakukan server, bukan disimpulkan frontend.

Pada penerimaan, hibah intake berakhir dan kunjungan scheduling nyata dibuat dengan hibah kunjungan sampai waktu selesai atau pembatalan. Selama hibah aktif, perawat terpilih hanya memperoleh konteks minimal booking tersebut: data skrining/snapshot kontak pada tahap intake, lalu identitas/interval terkonfirmasi dan proyeksi panduan perawatan pasien yang aktif pada tahap kunjungan. Ini bukan akses rekam medis lengkap: snapshot mentah, catatan internal, dan route chart umum tetap mengikuti penugasan perawat utama. Penolakan, pembatalan, atau berakhirnya hibah menghapus akses ke intake/kontak dan menyisakan metadata keputusan/riwayat minimal. Pemilihan perawat homecare tidak mengganti perawat utama.

Alur ordinary memerlukan slot kanonis yang cocok persis. Untuk waktu di luar availability, buat draf dengan interval UTC eksplisit dan pernyataan prioritas. Perawat terpilih memutuskan `accept_availability` atau `decline` secara manual dengan alasan. Status `availability_accepted` hanya mengizinkan penyerahan interval/perawat yang sama; pasien tetap harus menyerahkan booking dan perawat harus menerima booking sebagai dua tindakan berikutnya. Keputusan ini bukan penilaian urgensi klinis, bypass bentrok/batas aktif, dispatch darurat, atau keputusan AI. Pada reschedule booking yang telah diterima, pengecualian target baru juga harus disetujui untuk interval yang persis sebelum tindakan reschedule terpisah.

## Pemantauan risiko

Route `/pemantauan-risiko` menampilkan status layanan belum tersedia. Penilaian dan skor risiko klinis numerik tidak diimplementasikan, dihitung frontend, atau disimpulkan dari draf AI. Persetujuan analisis hanya berlaku pada revisi draf tersebut dan tidak menjadi skor maupun publikasi otomatis. Intake maupun persetujuan prioritas homecare juga tidak menghasilkan skor risiko.

## Profil perawat

Route `/profil` dibuka dari avatar/nama perawat pada header dan membaca identitas, kode staf, disiplin sumber, email, telepon, serta zona waktu tampilan dari sesi API yang aktif. Zona waktu tampilan akun tidak menjadi default availability; editor mewajibkan konfigurasi kalender yang eksplisit. Logout meminta server mengakhiri sesi cookie dan kembali ke login; ini bukan reset state demo lokal. Preferensi notifikasi dan hitungan pada mock awal bukan fitur ruang kerja aktif.

## Layanan yang belum tersedia pada Stop 5

Route berikut secara eksplisit menampilkan status belum tersedia, bukan mensimulasikan layanan:

- `/jadwal-kunjungan/[visitId]`: formulir catatan klinis kunjungan, penyelesaian, dan finalisasi belum tersedia. Ini berbeda dari `/jadwal-kunjungan`, yang sudah menampilkan serta mengelola kunjungan scheduling yang nyata.
- `/notifikasi` dan `/pasien/notifikasi`: riwayat notifikasi, status baca, preferensi pengiriman, pengingat, serta browser push belum tersedia.
- `/pemantauan-risiko`: skor dan penilaian risiko klinis belum tersedia.

Materi/finalisasi kunjungan Stop 5 tidak boleh disimpulkan dari keberadaan `visitId` pada booking yang diterima. Tidak ada skor, notifikasi, data risiko, atau catatan klinis kunjungan contoh yang boleh diperlakukan sebagai data produk langsung. Rujukan visual awal tidak mengubah batas implementasi ini.
