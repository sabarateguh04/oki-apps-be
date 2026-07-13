# CHANGELOG — Perbaikan OKI Dashboard

> ⚠️ **Update:** `migration_v2.sql` yang disebut di file ini **sudah
> dihapus**. Semua perubahan skema sekarang digabung jadi satu di
> `schema.sql` (yang sekarang mulai dengan `DROP TABLE` + `CREATE TABLE`
> ulang total). Lihat `CHANGELOG_FIX2.md` bagian "Cara Deploy" untuk
> instruksi terbaru. Bagian di bawah ini dibiarkan sebagai riwayat, tapi
> perintah `mysql ... < migration_v2.sql` di dalamnya sudah tidak berlaku.

## 1. RBAC BENERAN (server-side, bukan cuma sembunyiin tombol)
- Login sekarang mengeluarkan **JWT token** (`middleware/auth.js`, `routes/auth.route.js`).
- Semua route API dilindungi `requireAuth` + `requireRole(...)`:
  - **Buat tiket** → hanya `ADMIN`
  - **Approve/Reject** → hanya `ATASAN` (admin TIDAK bisa approve lagi)
  - **Pre-bayar-done / Jasa-teknisi-done / Tandai kebutuhan dibeli** → hanya `FINANCE`
  - **Assign teknisi** → hanya `ADMIN`, dan server **selalu** cek ulang syarat assign
    (approval, pre-bayar, kebutuhan pra-assign, TF jasa teknisi) — gak bisa dibypass
    lewat Postman/curl sekalipun.
  - **Master Customer / Master Teknisi** (create/update/delete) → hanya `ADMIN`
- Sidebar (`layout.js`) filter menu sesuai role.
- Kalau nekat buka halaman lewat URL langsung dengan role yang salah → diblok
  (403 dari server, dan halaman langsung nampilin pesan "hanya untuk role X").

**PENTING:** simpan `JWT_SECRET` di `.env` dengan string acak yang panjang & rahasia
(jangan pakai nilai default yang saya taruh di sana).

## 2. Dashboard: data null & peta gak muncul
- Peta pakai `map.invalidateSize()` setelah render — sebelumnya Leaflet salah hitung
  ukuran container pas topbar/layout belum selesai di-render, jadi peta blank.
- Error fetch KPI/monitoring sekarang muncul sebagai **toast**, gak lagi cuma
  `console.error` yang bikin data kelihatan "null" tanpa penjelasan. Kalau nanti
  masih null, buka Console browser — sekarang bakal keliatan pesan errornya
  (401 token habis / 500 DB error / dll).

## 3. Order form dilengkapi
Field baru di `form-order.html`:
- Wilayah, alamat detail lokasi trouble
- **Peta pilih titik lokasi trouble** (klik peta → lat/lng otomatis keisi)
- Tanggal mulai & target selesai (range)
- **Rincian biaya dinamis** (tabel `oki_order_biaya`, 1-ke-banyak per order) —
  tambah baris sebanyak apapun: Jasa, Transport, Material, atau Lainnya
  (mis. uang makan, parkir, dll masuk kategori Lainnya/Transport, tulis aja
  detailnya di kolom Deskripsi), masing-masing punya timing bayar sendiri
  (Sebelum/Sesudah). Gak dibatasi jumlahnya.
- **Kebutuhan pra-assign** (checklist barang yang harus dibeli/ditransfer sebelum
  assign, mis. modem/sparepart) — kalau ada yang masih "Pending", tombol Assign
  di halaman detail order otomatis terkunci sampai Finance menandai semua "Dibeli".

## 3b. Upload bukti transfer (file asli, bukan link teks lagi)
- File disimpan di `uploads/bukti/` (di-buat otomatis saat server nyala) dan
  diakses publik lewat `/uploads/bukti/<namafile>`.
- Berlaku untuk: **pre-bayar**, **transfer jasa teknisi**, dan **tiap item
  kebutuhan pra-assign** (masing-masing item bisa punya buktinya sendiri).
- Format diterima: JPG, PNG, WEBP, PDF — maksimal 5MB (bisa diubah di
  `middleware/upload.js`, cari `fileSize`).
- Finance tinggal pilih file di halaman Detail Order, lalu klik "Tandai Selesai" —
  otomatis keupload & linknya muncul buat dilihat lagi kapan saja.

## 4. Master Teknisi dilengkapi
Spesialisasi, sertifikasi, wilayah kerja, alamat, tanggal lahir, No. KTP,
nama bank, no. rekening, nama pemilik rekening.

## 5. Master Customer dilengkapi
Provinsi, kab/kota, kecamatan, kode pos, telp perusahaan, email PIC.

## 6. Order Detail
- Nampilin rincian biaya per item, kebutuhan pra-assign (dengan tombol "Tandai
  Dibeli" khusus Finance), bukti transfer (link/nama file) untuk pre-bayar &
  jasa teknisi, peta titik lokasi trouble.
- Tombol Approve/Reject cuma nongol untuk Atasan, tombol Assign cuma untuk Admin.

## 7. Bug kritis: halaman "nge-freeze" tanpa pesan error (harus refresh dulu)
Ternyata ada beberapa halaman (`dashboard.html`, `orders.html`) yang manggil
fungsi (misal `loadOrders(1)`, `boot()`) SEBELUM variabel yang dipakai fungsi
itu (`currentPage`, `map`, dll) sempat dideklarasikan — di JavaScript ini
namanya *Temporal Dead Zone*, dan begitu kena, itu bikin SELURUH sisa kode di
`<script>` itu berhenti jalan seketika tanpa pesan error yang keliatan (uncaught
exception). Makanya data kelihatan kosong/kayak ilang sampai halaman
di-refresh manual (padahal refresh cuma nge-restart eksekusi script dari nol,
jadi kebetulan lolos lagi). Ini juga penyebab **peta di dashboard gak muncul**.
Sudah dibenerin di semua halaman (variabel dipindah ke atas sebelum dipanggil).

## 8. Assign teknisi: sekarang bisa "flagging" duluan + multi-teknisi
- Admin sekarang bisa **pilih/tandai rencana teknisi kapan aja** — bahkan
  sebelum atasan approve atau sebelum finance transfer. Ini cuma nge-flag
  (status `PLANNED`), BUKAN assign beneran — order belum berubah status,
  teknisi belum ON_DUTY. Fungsinya cuma referensi: biar Finance tau mau
  transfer ke siapa.
- Begitu semua syarat kekunci (approval, pre-bayar, kebutuhan pra-assign,
  TF jasa teknisi) sudah lolos, admin tinggal klik **"Konfirmasi & Assign
  Sekarang"** — teknisi yang tadi di-flag otomatis dipromosikan jadi
  `ASSIGNED` beneran (order jadi status ASSIGNED, teknisi jadi ON_DUTY).
  Admin juga bisa tambah/ganti teknisi di langkah konfirmasi ini.
- **Satu order sekarang bisa dikerjakan lebih dari satu teknisi sekaligus**
  (tabel baru `oki_order_technicians`, many-to-many). Semua teknisi yang
  ASSIGNED bisa update status progres order, dan begitu order selesai/batal,
  semua teknisi yang assigned otomatis balik READY.

## 9. Lampiran pendukung & bukti transfer — sekarang bisa lebih dari 1 file
- Form order sekarang ada bagian **"Lampiran Pendukung"** — tambah sebanyak
  apapun baris, masing-masing punya **judul** + file (foto kondisi, PO, dll).
- **Semua bukti transfer** (pre-bayar, jasa teknisi, kebutuhan pra-assign per
  item) sekarang nerima **banyak file sekaligus** (input `multiple`), bukan
  cuma 1. Semua histori filenya kesimpen (tabel baru `oki_order_files`,
  generik buat semua kategori lampiran/bukti) dan ditampilkan sebagai
  chip-chip link yang bisa diklik di halaman Detail Order.

## 10. Peta di Detail Order
- Kalau order belum punya titik lokasi trouble spesifik, sekarang otomatis
  **fallback ke lokasi customer** (kalau ada) — jadi jarang banget peta
  bener-bener kosong.
- Peta juga dibikin lebih tahan banting (`invalidateSize()` + re-render pas
  window di-resize), sama kayak perbaikan poin 7 di atas.



## 11. Alur tawaran tugas: teknisi bisa terima/tolak
Sebelumnya "flagging" langsung jadi rencana tanpa ada konfirmasi dari
teknisi. Sekarang alurnya:
1. **Admin nge-flag/nawarin** 1 teknisi (status `PLANNED`) — boleh kapan
   aja, bahkan sebelum atasan approve.
2. **Teknisi dapet notifikasi** (real-time via Socket.IO) di halaman
   Profile-nya sendiri, ada tombol **Terima** / **Tolak**.
   - **Tolak** → tawaran itu jadi riwayat (`REJECTED`), admin tinggal
     tawarin ke teknisi lain dari halaman Detail Order.
   - **Terima** → status jadi `ACCEPTED`. Di titik ini **Finance sudah
     bisa lihat rekening tujuan transfer** (nama bank/no rekening
     teknisi ditampilkan di Detail Order), tapi transfer beneran BARU
     boleh jalan kalau atasan sudah approve (lihat poin 12).
3. **Admin klik "Konfirmasi & Assign Sekarang"** — mempromosikan teknisi
   yang `ACCEPTED` jadi `ASSIGNED` final, setelah semua syarat (approval +
   kebutuhan dibeli + biaya "Sebelum" lunas) terpenuhi. Baru di titik ini
   teknisi boleh mulai kerja (update status Menuju Lokasi/Dikerjakan/Selesai).

## 12. Pembayaran per-item biaya (bukan lagi 1 kondisi pre-bayar)
Setiap baris di Rincian Biaya (jasa/transport/material/lainnya) sekarang
punya status transfer sendiri-sendiri, dengan aturan:
- **Timing "Sebelum"** (mis. transport, uang makan, DP material) → Finance
  boleh transfer begitu **atasan approve** (gak perlu nunggu apa-apa lagi).
  Ini juga yang ngeblok tombol "Konfirmasi & Assign" kalau belum lunas.
- **Timing "Sesudah"** (mis. jasa teknisi) → Finance baru boleh transfer
  setelah **atasan approve DAN pekerjaan berstatus DONE** (teknisi udah
  nyelesein kerjaannya). Ini TIDAK ngeblok assign — teknisi tetap bisa
  dikerjakan duluan, dibayar belakangan.

Field order-level lama (`has_pre_bayar`, `payment_timing`, dst) sudah gak
dipakai lagi di kode (kolomnya masih ada di DB tapi nganggur, aman).

## 13. Halaman Teknisi: Riwayat Tugas
Sebelumnya cuma nampilin "Order Aktif" dan yang udah selesai kelihatan
hilang. Sekarang ada card baru **"Riwayat Tugas"** yang nampilin SEMUA
order yang statusnya DONE/CLOSED/CANCELLED/REJECTED buat teknisi itu, jadi
histori kerjanya gak ilang.

## 14. Admin gak bisa lagi ubah status pengerjaan
Sesuai request: Admin sekarang cuma bisa **buat tiket, flagging/tawarin
teknisi, batalin order, dan "Close" tiket** (setelah semuanya kelar).
Update status pengerjaan (Menuju Lokasi → Dikerjakan → Selesai) SEKARANG
CUMA bisa dilakukan teknisi yang bersangkutan dari halaman Profile mereka
sendiri — baik dari sisi backend (endpoint nolak kalau bukan teknisi yang
assigned) maupun frontend (tombol-tombolnya udah dihapus dari halaman
Detail Order versi Admin).

## 15. Status baru: CLOSED
Alur order sekarang: `NEW → ASSIGNED → ON_THE_WAY → IN_PROGRESS → DONE →
CLOSED`. Setelah teknisi menyelesaikan (DONE), Admin cek semua bukti &
transfer, baru klik **"Tutup Tiket"** — tombol ini otomatis kekunci kalau
masih ada biaya yang belum ditransfer Finance.

---

## CARA DEPLOY

1. **Update database** — pilih salah satu:
   - **DB sudah ada isinya** → jalankan `migration_v2.sql` (isinya
     bertahap V1→V4, semuanya di satu file, tinggal jalanin sekali):
     ```
     mysql -h <host> -u <user> -p <database> < migration_v2.sql
     ```
     ⚠️ **Kalau sebelumnya SUDAH PERNAH jalanin migration_v2.sql** (versi
     yang ada V1-V3 aja), jangan run ulang dari awal — nanti kena error
     "Duplicate column"/"Duplicate key" di bagian yang udah pernah jalan.
     Cukup copy-paste & jalankan bagian **`MIGRATION V4`** aja (paling
     bawah file, ada komentar jelas batasnya) lewat kotak SQL di
     phpMyAdmin.
   - **Mulai dari kosong** → pakai `schema.sql` yang sudah diperbarui (sudah
     termasuk semua kolom & tabel terbaru, tinggal Import sekali).

2. **Install dependency baru** (jsonwebtoken + multer sudah ditambahkan ke
   `package.json`):
   ```
   npm install
   ```

3. **Set `JWT_SECRET`** di `.env` (ganti dari nilai default).

4. **Pastikan ada user dengan role ATASAN & FINANCE** di tabel `oki_users`
   (cek dulu: `SELECT username, role FROM oki_users;`). Kalau belum ada,
   tambahkan (lihat contoh di bagian bawah `migration_v2.sql`).

5. Jalankan seperti biasa:
   ```
   node server.js
   ```
   Folder `uploads/bukti/` otomatis dibuat sendiri saat server nyala — gak
   perlu bikin manual.

## Yang BELUM saya kerjakan (di luar scope kode, butuh keputusan bisnis Anda)
- Foto KTP teknisi masih data teks (No. KTP), belum upload gambar KTP-nya.
  Kalau perlu, tinggal bilang — tinggal pasang endpoint upload yang sama
  kayak bukti transfer.
- Backup/retensi file di `uploads/` — sekarang cuma disimpan di disk server.
  Kalau nanti pindah ke hosting/VPS baru, folder ini harus ikut dipindah
  (atau upgrade ke S3/object storage kalau butuh lebih robust).
