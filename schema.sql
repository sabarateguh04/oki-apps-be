-- ═══════════════════════════════════════════════════════════════════
-- OKI MAINTENANCE SYSTEM — DATABASE SCHEMA
-- Mengimplementasikan alur: Order → Approval Atasan → Pre-Bayar (opsional)
-- → Transfer Jasa Teknisi (kondisional) → Assign Teknisi → GPS Tracking
-- (dikirim tiap 30 detik selama teknisi berstatus READY) → Dashboard.
-- ═══════════════════════════════════════════════════════════════════

CREATE DATABASE IF NOT EXISTS test
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE test;

-- ───────────────────────────────────────────────────────────
-- RESET TOTAL — drop semua tabel oki_* lama (kalau ada) sebelum bikin
-- ulang dari nol. INI MENGHAPUS SEMUA DATA yang sekarang ada di tabel-tabel
-- ini. FOREIGN_KEY_CHECKS dimatikan sementara biar urutan drop-nya gak
-- perlu dipikirin manual (aman, langsung dinyalain lagi di bawah).
--
-- ⚠️  JALANKAN INI SADAR-SADAR — kalau database `test` kamu udah ada data
--     order/customer/teknisi yang penting, BACKUP DULU sebelum run file
--     ini (mysqldump test > backup.sql), karena ini bukan migration
--     tambah-kolom lagi, tapi reset total.
-- ───────────────────────────────────────────────────────────
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS
  oki_order_files,
  oki_order_technicians,
  oki_order_biaya,
  oki_order_kebutuhan,
  oki_order_timeline,
  oki_technician_locations,
  oki_orders,
  oki_customer_sites,
  oki_technicians,
  oki_customers,
  oki_users;
SET FOREIGN_KEY_CHECKS = 1;

-- ───────────────────────────────────────────────────────────
-- 1. USERS — staff internal (admin, atasan/approver, finance, dispatcher)
-- ───────────────────────────────────────────────────────────
CREATE TABLE oki_users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(100) NOT NULL UNIQUE,
  password      VARCHAR(255) NOT NULL,          -- bcrypt hash
  nama          VARCHAR(150) NOT NULL,
  role          ENUM('ADMIN','ATASAN','FINANCE','DISPATCHER') NOT NULL DEFAULT 'DISPATCHER',
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ───────────────────────────────────────────────────────────
-- 2. CUSTOMERS
-- ───────────────────────────────────────────────────────────
CREATE TABLE oki_customers (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  nama_perusahaan VARCHAR(200) NOT NULL,
  pic_nama        VARCHAR(150),
  pic_hp          VARCHAR(30),
  pic_email       VARCHAR(150) NULL,
  alamat          TEXT,
  provinsi        VARCHAR(100) NULL,
  kabupaten_kota  VARCHAR(100) NULL,
  kecamatan       VARCHAR(100) NULL,
  kode_pos        VARCHAR(10)  NULL,
  telp_perusahaan VARCHAR(30)  NULL,
  latitude        DECIMAL(10,7) NULL,
  longitude       DECIMAL(10,7) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ───────────────────────────────────────────────────────────
-- 2b. CUSTOMER_SITES — titik lokasi kerja yang TERDAFTAR per customer.
-- Ini yang jadi SATU-SATUNYA sumber titik lokasi buat order (lihat kolom
-- site_id di oki_orders) — gak ada lagi input lat/lng/alamat manual pas
-- bikin order, semua wajib pilih dari sini biar datanya konsisten &
-- gak typo/salah titik tiap kali ada tiket baru ke lokasi yang sama.
-- kode_site UNIQUE per customer (bukan global) — jadi 2 customer beda
-- boleh aja kebetulan pakai kode yang sama, tapi 1 customer gak boleh
-- punya 2 site dengan kode sama.
-- ───────────────────────────────────────────────────────────
CREATE TABLE oki_customer_sites (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  customer_id         INT NOT NULL,
  kode_site           VARCHAR(50) NOT NULL,
  site_name           VARCHAR(150) NOT NULL,
  kategori            ENUM('PREVENTIVE','CORRECTIVE','INSTALLATION','INSPECTION') NOT NULL DEFAULT 'CORRECTIVE',
  latitude            DECIMAL(10,7) NULL,
  longitude           DECIMAL(10,7) NULL,
  provinsi            VARCHAR(100) NULL,
  kota                VARCHAR(100) NULL,
  kecamatan           VARCHAR(100) NULL,
  kelurahan           VARCHAR(100) NULL,
  alamat_detail       TEXT NULL,
  keterangan_pekerjaan VARCHAR(255) NULL,
  status_projek       ENUM('ACTIVE','NON_ACTIVE') NOT NULL DEFAULT 'ACTIVE',
  status_gangguan     ENUM('BERJALAN','GANGGUAN','MAINTENANCE') NOT NULL DEFAULT 'BERJALAN',
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES oki_customers(id) ON DELETE CASCADE,
  UNIQUE KEY uniq_customer_kode_site (customer_id, kode_site),
  INDEX idx_site_customer (customer_id)
) ENGINE=InnoDB;

-- ───────────────────────────────────────────────────────────
-- 3. TECHNICIANS (teknisi)
-- status: OFFLINE (default) → READY (siap jalan, mulai kirim GPS tiap 30
-- detik dari mobile/app) → ON_DUTY (lagi pegang 1 order aktif).
-- ───────────────────────────────────────────────────────────
CREATE TABLE oki_technicians (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  username        VARCHAR(100) NOT NULL UNIQUE,
  password        VARCHAR(255) NOT NULL,        -- bcrypt hash
  nama            VARCHAR(150) NOT NULL,
  no_hp           VARCHAR(30),
  email           VARCHAR(150),
  skill           VARCHAR(150) NULL,            -- mis. "Elektrikal, HVAC"
  spesialisasi    VARCHAR(200) NULL,
  sertifikasi     VARCHAR(255) NULL,
  wilayah_kerja   VARCHAR(150) NULL,
  alamat          TEXT NULL,
  tanggal_lahir   DATE NULL,
  no_ktp          VARCHAR(30) NULL,
  nama_bank       VARCHAR(100) NULL,
  no_rekening     VARCHAR(50) NULL,
  nama_rekening   VARCHAR(150) NULL,
  status          ENUM('OFFLINE','READY','ON_DUTY') NOT NULL DEFAULT 'OFFLINE',
  latitude        DECIMAL(10,7) NULL,
  longitude       DECIMAL(10,7) NULL,
  last_location_at DATETIME NULL,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- Riwayat titik GPS teknisi (buat trail/jejak di peta + analitik SLA nanti).
-- Baris "posisi sekarang" tetap di technicians.latitude/longitude supaya
-- query dashboard gak perlu subquery MAX(recorded_at) tiap saat.
-- (Tabelnya didefinisikan di Bagian 5, SETELAH `oki_orders`, karena ada FK ke
--  oki_orders.id — MySQL butuh tabel yang dirujuk sudah ada duluan.)

-- ───────────────────────────────────────────────────────────
-- 4. ORDERS — inti sistem
-- ───────────────────────────────────────────────────────────
CREATE TABLE oki_orders (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  order_no        VARCHAR(20) NOT NULL UNIQUE,      -- ORD-00001
  customer_id     INT NOT NULL,
  site_id         INT NULL,        -- WAJIB diisi dari oki_customer_sites (lihat catatan di bawah)

  category        ENUM('PREVENTIVE','CORRECTIVE','INSTALLATION','INSPECTION') NOT NULL DEFAULT 'CORRECTIVE',
  priority        ENUM('LOW','MEDIUM','HIGH') NOT NULL DEFAULT 'MEDIUM',
  description     TEXT,

  -- ── Lokasi & jadwal pengerjaan ──
  -- wilayah/alamat_detail/lokasi_lat/lokasi_lng di-SALIN otomatis dari
  -- oki_customer_sites pas order dibuat (server yang isi, bukan input
  -- manual admin) — disimpan di sini juga sebagai SNAPSHOT, supaya kalau
  -- suatu saat data site-nya diedit/berubah, riwayat order lama tetap
  -- nunjukin lokasi yang benar waktu itu (gak ikut berubah retroaktif).
  wilayah                 VARCHAR(150) NULL,
  alamat_detail           TEXT NULL,
  lokasi_lat              DECIMAL(10,7) NULL,     -- titik lokasi trouble (bisa beda dari alamat customer)
  lokasi_lng              DECIMAL(10,7) NULL,
  tanggal_mulai           DATE NULL,
  tanggal_selesai_target  DATE NULL,

  -- ── Status utama alur pekerjaan ──
  -- NEW → (approval) → ASSIGNED → ON_THE_WAY → IN_PROGRESS → DONE → CLOSED
  -- (CLOSED = admin sudah cek semua bukti & biaya, tiket ditutup final)
  -- REJECTED / CANCELLED bisa kejadian di step manapun sebelum DONE.
  status          ENUM('NEW','ASSIGNED','ON_THE_WAY','IN_PROGRESS','DONE','CLOSED','REJECTED','CANCELLED')
                  NOT NULL DEFAULT 'NEW',

  -- ── CONDITION 1: Approval atasan ──
  approval_status ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
  approved_by     INT NULL,
  approved_at     DATETIME NULL,
  approval_note   VARCHAR(255) NULL,

  -- CATATAN: pembayaran (pre-bayar material, transport, jasa teknisi, dll)
  -- sekarang dilacak PER ITEM di tabel oki_order_biaya (kolom status/timing_bayar),
  -- bukan lagi kolom lump-sum di sini. Lihat oki_order_biaya di bawah.

  -- ── Assignment teknisi (siapa yg konfirmasi assign, kapan; teknisi
  --    yang beneran ngerjain ada di tabel oki_order_technicians, bisa >1) ──
  assigned_by     INT NULL,
  assigned_at     DATETIME NULL,

  -- ── Biaya (ringkasan; rincian per item ada di oki_order_biaya) ──
  biaya_jasa      DECIMAL(14,2) NOT NULL DEFAULT 0,
  biaya_sparepart DECIMAL(14,2) NOT NULL DEFAULT 0,
  biaya_transport DECIMAL(14,2) NOT NULL DEFAULT 0,

  -- ── Waktu (buat SLA & analitik) ──
  created_by      INT NOT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  selesai_at      DATETIME NULL,                 -- diisi otomatis saat status → DONE

  FOREIGN KEY (customer_id)   REFERENCES oki_customers(id),
  FOREIGN KEY (approved_by)   REFERENCES oki_users(id),
  FOREIGN KEY (assigned_by)   REFERENCES oki_users(id),
  FOREIGN KEY (created_by)    REFERENCES oki_users(id),
  FOREIGN KEY (site_id)       REFERENCES oki_customer_sites(id),

  INDEX idx_status (status),
  INDEX idx_approval (approval_status),
  INDEX idx_created (created_at)
) ENGINE=InnoDB;

-- ───────────────────────────────────────────────────────────
-- 5. OKI_TECHNICIAN_LOCATIONS (versi final, setelah `oki_orders` ada)
-- ───────────────────────────────────────────────────────────
CREATE TABLE oki_technician_locations (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  technician_id INT NOT NULL,
  order_id      INT NULL,
  latitude      DECIMAL(10,7) NOT NULL,
  longitude     DECIMAL(10,7) NOT NULL,
  recorded_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (technician_id) REFERENCES oki_technicians(id) ON DELETE CASCADE,
  FOREIGN KEY (order_id) REFERENCES oki_orders(id) ON DELETE SET NULL,
  INDEX idx_tech_time (technician_id, recorded_at)
) ENGINE=InnoDB;

-- ───────────────────────────────────────────────────────────
-- 6. ORDER_TIMELINE — log aktivitas per order (buat "Timeline Pekerjaan"
--    di halaman detail order + feed "Aktivitas Terbaru" di dashboard)
-- ───────────────────────────────────────────────────────────
CREATE TABLE oki_order_timeline (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_id    INT NOT NULL,
  event_type  VARCHAR(50) NOT NULL,      -- CREATED, APPROVED, REJECTED, PRE_BAYAR_DONE,
                                          -- JASA_TF_DONE, ASSIGNED, ON_THE_WAY, IN_PROGRESS,
                                          -- DONE, CANCELLED, NOTE
  note        VARCHAR(500) NULL,
  actor_type  ENUM('USER','TECHNICIAN','SYSTEM') NOT NULL DEFAULT 'SYSTEM',
  actor_id    INT NULL,                  -- users.id ATAU technicians.id, tergantung actor_type
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES oki_orders(id) ON DELETE CASCADE,
  INDEX idx_order_time (order_id, created_at)
) ENGINE=InnoDB;

-- ───────────────────────────────────────────────────────────
-- 7. KEBUTUHAN PRA-ASSIGN — barang/jasa yang wajib dibeli/ditransfer
--    SEBELUM order boleh di-assign ke teknisi (mis. beli modem, sparepart
--    khusus). Kalau ada baris di sini yang belum DIBELI, tombol Assign
--    tetap terkunci.
-- ───────────────────────────────────────────────────────────
CREATE TABLE oki_order_kebutuhan (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  order_id        INT NOT NULL,
  nama_item       VARCHAR(200) NOT NULL,
  qty             INT NOT NULL DEFAULT 1,
  estimasi_harga  DECIMAL(14,2) NULL,
  status          ENUM('PENDING','DIBELI') NOT NULL DEFAULT 'PENDING',
  keterangan      VARCHAR(255) NULL,
  bukti_url       VARCHAR(500) NULL,           -- bukti pembelian/transfer diupload Finance
  dibeli_by       INT NULL,
  dibeli_at       DATETIME NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES oki_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (dibeli_by) REFERENCES oki_users(id)
) ENGINE=InnoDB;

-- ───────────────────────────────────────────────────────────
-- 8. RINCIAN BIAYA — pecahan biaya per jenis (jasa/transport/material/lain)
--    beserta timing bayarnya masing2.
-- ───────────────────────────────────────────────────────────
CREATE TABLE oki_order_biaya (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  order_id        INT NOT NULL,
  jenis           ENUM('JASA','TRANSPORT','MATERIAL','LAINNYA') NOT NULL DEFAULT 'LAINNYA',
  deskripsi       VARCHAR(200) NULL,
  jumlah          DECIMAL(14,2) NOT NULL DEFAULT 0,
  timing_bayar    ENUM('SEBELUM','SESUDAH') NOT NULL DEFAULT 'SESUDAH',
  -- Aturan pembayaran per item:
  --   SEBELUM -> Finance boleh TF begitu atasan APPROVE (gak perlu nunggu task selesai)
  --   SESUDAH -> Finance baru boleh TF setelah atasan APPROVE **dan** order.status = DONE
  status          ENUM('PENDING','DONE') NOT NULL DEFAULT 'PENDING',
  paid_by         INT NULL,
  paid_at         DATETIME NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES oki_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (paid_by) REFERENCES oki_users(id)
) ENGINE=InnoDB;

-- ───────────────────────────────────────────────────────────
-- 9. TEKNISI PER ORDER (many-to-many). Satu order bisa dikerjakan LEBIH
--    DARI SATU teknisi, dan ada alur tawaran-terima/tolak:
--
--    PLANNED  = admin nge-flag/nawarin ke 1 teknisi (boleh kapan aja,
--               bahkan sebelum atasan approve / finance TF — cuma
--               referensi awal buat Finance mau transfer ke siapa).
--    ACCEPTED = teknisi TERIMA tawaran. Finance udah pasti tau harus
--               TF ke siapa, tapi TF beneran baru boleh jalan kalau
--               syarat lain (approval atasan, dst) juga udah lolos.
--    REJECTED = teknisi TOLAK tawaran. Admin flag teknisi lain buat
--               menggantikan (bikin baris PLANNED baru).
--    ASSIGNED = FINAL — dikonfirmasi admin setelah semua syarat lolos
--               (approval + kebutuhan dibeli + biaya SEBELUM lunas +
--               minimal 1 teknisi ACCEPTED). Ini yang bikin teknisi
--               boleh mulai kerja (ON_THE_WAY dst).
-- ───────────────────────────────────────────────────────────
CREATE TABLE oki_order_technicians (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  order_id        INT NOT NULL,
  technician_id   INT NOT NULL,
  status          ENUM('PLANNED','ACCEPTED','REJECTED','ASSIGNED') NOT NULL DEFAULT 'PLANNED',
  response_note   VARCHAR(255) NULL,      -- alasan/catatan waktu teknisi accept/reject
  responded_at    DATETIME NULL,
  assigned_by     INT NULL,
  assigned_at     DATETIME NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_order_tech (order_id, technician_id),
  FOREIGN KEY (order_id) REFERENCES oki_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (technician_id) REFERENCES oki_technicians(id),
  FOREIGN KEY (assigned_by) REFERENCES oki_users(id)
) ENGINE=InnoDB;

-- ───────────────────────────────────────────────────────────
-- 10. FILE / BUKTI — satu tabel generik buat SEMUA jenis lampiran & bukti,
--     boleh lebih dari satu file per kategori:
--       LAMPIRAN  = lampiran pendukung waktu bikin order (bisa ada judul)
--       BIAYA     = bukti transfer 1 item di oki_order_biaya (ref_id = id-nya)
--       KEBUTUHAN = bukti pembelian 1 item kebutuhan pra-assign
--                   (ref_id = id baris oki_order_kebutuhan)
--       PEKERJAAN = bukti hasil kerja diupload TEKNISI sendiri (foto dsb),
--                   uploaded_by_technician_id yang keisi, bukan uploaded_by
-- ───────────────────────────────────────────────────────────
CREATE TABLE oki_order_files (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  order_id        INT NOT NULL,
  kategori        ENUM('LAMPIRAN','BIAYA','KEBUTUHAN','PEKERJAAN') NOT NULL,
  ref_id          INT NULL,
  judul           VARCHAR(200) NULL,
  file_url        VARCHAR(500) NOT NULL,
  uploaded_by                INT NULL,   -- oki_users.id, kalau yang upload staff
  uploaded_by_technician_id  INT NULL,   -- oki_technicians.id, kalau yang upload teknisi (salah satu selalu NULL)
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES oki_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES oki_users(id),
  FOREIGN KEY (uploaded_by_technician_id) REFERENCES oki_technicians(id)
) ENGINE=InnoDB;

-- ───────────────────────────────────────────────────────────
-- SEED DATA MINIMAL (biar bisa langsung dites)
-- Password semua akun contoh di bawah: "password123"
-- (hash bcrypt asli, cost 10 — bukan placeholder, tinggal pakai)
-- ───────────────────────────────────────────────────────────
INSERT INTO oki_users (username, password, nama, role) VALUES
  ('admin',   '$2b$10$.gI0Q57pTsFDt0cbQBpDb.qq2m6KPafkaQOBaQwnpp1uIbUcXnM62', 'Administrator', 'ADMIN'),
  ('atasan1', '$2b$10$.gI0Q57pTsFDt0cbQBpDb.qq2m6KPafkaQOBaQwnpp1uIbUcXnM62', 'Budi Manager',  'ATASAN'),
  ('finance1','$2b$10$.gI0Q57pTsFDt0cbQBpDb.qq2m6KPafkaQOBaQwnpp1uIbUcXnM62', 'Siti Finance',  'FINANCE');

INSERT INTO oki_customers (nama_perusahaan, pic_nama, pic_hp, alamat) VALUES
  ('PT ABC Indonesia', 'Budi Santoso', '081234567890', 'Jl. Margonda Raya No.100 Depok');

INSERT INTO oki_customer_sites
  (customer_id, kode_site, site_name, kategori, latitude, longitude, provinsi, kota, kecamatan, kelurahan, alamat_detail, keterangan_pekerjaan, status_projek, status_gangguan) VALUES
  (1, 'DPK-01', 'Kantor Cabang Depok', 'INSTALLATION', -6.3728, 106.8317, 'Jawa Barat', 'Depok', 'Beji', 'Kemiri Muka', 'Jl. Margonda Raya No.100, Kemiri Muka, Beji, Depok', 'Pemasangan jaringan internet', 'ACTIVE', 'BERJALAN');

INSERT INTO oki_technicians (username, password, nama, no_hp, email, skill) VALUES
  ('teknisi1', '$2b$10$.gI0Q57pTsFDt0cbQBpDb.qq2m6KPafkaQOBaQwnpp1uIbUcXnM62', 'Andi Wijaya', '081212121212', 'andi@email.com', 'Elektrikal');

  
ALTER TABLE oki_order_timeline
  ADD COLUMN notif_roles VARCHAR(100) NULL AFTER actor_id;
 
ALTER TABLE oki_order_timeline
  ADD INDEX idx_timeline_created (created_at);


ALTER TABLE oki_order_ba_checklist
  ADD COLUMN revision_note VARCHAR(255) NULL AFTER note_ba; 



  -- ═══════════════════════════════════════════════════════════════════
-- ADDON: MASTER BA (BERITA ACARA) TEMPLATE PER CUSTOMER
--
-- Jalankan file ini SETELAH schema.sql utama sudah ada (butuh tabel
-- oki_customers, oki_orders, oki_order_files, oki_technicians).
-- Ini migration TAMBAH tabel baru saja -- TIDAK drop/ubah tabel lama,
-- aman dijalankan di database yang sudah ada datanya.
--
-- CARA JALANIN:
--   mysql -u root -p test < schema_ba_addon.sql
-- (ganti 'test' kalau nama database production kamu beda)
-- ═══════════════════════════════════════════════════════════════════
USE test;

-- ───────────────────────────────────────────────────────────
-- 1. MASTER BA — 1 customer maksimal 1 BA aktif (UNIQUE id_customer).
--    Kalau baris ini ADA untuk suatu customer, artinya customer itu
--    "punya BA" dan order barunya wajib checklist. Kalau TIDAK ADA,
--    order jalan bebas seperti sekarang (tanpa checklist).
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oki_customers_ba (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  id_customer   INT NOT NULL,
  ba_name       VARCHAR(200) NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_customer_ba (id_customer),
  FOREIGN KEY (id_customer) REFERENCES oki_customers(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ───────────────────────────────────────────────────────────
-- 2. TEMPLATE ITEM — daftar item checklist wajib per BA.
--    category bebas diisi admin (VARCHAR, bukan ENUM) -- misal "SN",
--    "INSTALASI", "PERANGKAT", "LAINNYA", atau kategori baru apapun.
--    template_type nentuin cara teknisi ngisi: 'file' (upload foto/dok)
--    atau 'text' (input manual, misal serial number).
--    urutan buat nentuin urutan tampil di checklist (kecil ke besar).
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oki_customers_ba_template (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  id_customers_ba   INT NOT NULL,
  category          VARCHAR(100) NOT NULL,
  template_name     VARCHAR(200) NOT NULL,
  template_type     ENUM('file','text') NOT NULL DEFAULT 'file',
  note_ba           VARCHAR(255) NULL,
  urutan            INT NOT NULL DEFAULT 0,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (id_customers_ba) REFERENCES oki_customers_ba(id) ON DELETE CASCADE,
  INDEX idx_ba_template (id_customers_ba)
) ENGINE=InnoDB;

-- ───────────────────────────────────────────────────────────
-- 3. SNAPSHOT CHECKLIST PER ORDER — disalin dari
--    oki_customers_ba_template PAS ORDER DIBUAT (bukan direferensi
--    live). Kalau admin edit/hapus template belakangan, checklist di
--    order yang SUDAH ADA gak ikut berubah -- persis pola snapshot
--    lokasi site (oki_orders.wilayah/alamat_detail) yang sudah ada.
--
--    template_id boleh NULL (ON DELETE SET NULL) -- kalau item
--    template aslinya dihapus admin, histori checklist di order lama
--    tetap utuh, cuma link "item asalnya" jadi kosong.
--
--    status DONE kalau:
--      - template_type='text'  -> text_value sudah diisi
--      - template_type='file'  -> file_id sudah terisi (link ke 1
--        baris oki_order_files kategori PEKERJAAN_BA)
-- ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS oki_order_ba_checklist (
  id                        INT AUTO_INCREMENT PRIMARY KEY,
  order_id                  INT NOT NULL,
  template_id               INT NULL,
  category                  VARCHAR(100) NOT NULL,
  template_name             VARCHAR(200) NOT NULL,
  template_type             ENUM('file','text') NOT NULL,
  note_ba                   VARCHAR(255) NULL,
  urutan                    INT NOT NULL DEFAULT 0,
  status                    ENUM('PENDING','DONE') NOT NULL DEFAULT 'PENDING',
  text_value                VARCHAR(500) NULL,
  file_id                   INT NULL,
  filled_by_technician_id   INT NULL,
  filled_at                 DATETIME NULL,
  created_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES oki_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (template_id) REFERENCES oki_customers_ba_template(id) ON DELETE SET NULL,
  FOREIGN KEY (file_id) REFERENCES oki_order_files(id) ON DELETE SET NULL,
  FOREIGN KEY (filled_by_technician_id) REFERENCES oki_technicians(id),
  INDEX idx_checklist_order (order_id)
) ENGINE=InnoDB;

-- ───────────────────────────────────────────────────────────
-- 4. Tambah 'PEKERJAAN_BA' ke ENUM kategori oki_order_files, supaya
--    file bukti checklist BA kepisah dari bukti bebas ('PEKERJAAN')
--    yang lama. Aman dijalankan walau tabelnya sudah ada isinya.
-- ───────────────────────────────────────────────────────────
ALTER TABLE oki_order_files
  MODIFY COLUMN kategori ENUM('LAMPIRAN','BIAYA','KEBUTUHAN','PEKERJAAN','PEKERJAAN_BA') NOT NULL;

-- ───────────────────────────────────────────────────────────
-- CONTOH DATA (opsional, hapus/comment kalau gak mau seed) --
-- mengikuti contoh "Ba sekolah rakyat" di customer_id = 1
-- ───────────────────────────────────────────────────────────
-- INSERT INTO oki_customers_ba (id_customer, ba_name) VALUES (1, 'Ba sekolah rakyat');
-- INSERT INTO oki_customers_ba_template (id_customers_ba, category, template_name, template_type, note_ba, urutan) VALUES
--   (1, 'SN', 'SN # Switch Distribution & Access - 1', 'text', 'scan barcode / manual input serial number', 1),
--   (1, 'SN', 'SN # Switch Distribution & Access - 2', 'text', 'scan barcode / manual input serial number', 2),
--   (1, 'SN', 'SN # Switch Distribution & Access - 3', 'text', 'scan barcode / manual input serial number', 3),
--   (1, 'INSTALASI', 'Instalasi # Perkabelan', 'file', 'upload foto from camera / gallery', 4),
--   (1, 'INSTALASI', 'Instalasi # Pemasangan Perangkat dan Integrasi', 'file', 'upload foto from camera / gallery', 5),
--   (1, 'INSTALASI', 'Instalasi # Integrasi Fisik Mini PC', 'file', 'upload foto from camera / gallery', 6),
--   (1, 'PERANGKAT', 'Antena', 'file', 'upload foto from camera / gallery', 7),
--   (1, 'PERANGKAT', 'Router', 'file', 'upload foto from camera / gallery', 8),
--   (1, 'PERANGKAT', 'Switch', 'file', 'upload foto from camera / gallery', 9),
--   (1, 'LAINNYA', 'Hasil ping', 'file', 'upload foto from camera / gallery', 10),
--   (1, 'LAINNYA', 'Speedtest Bandwidth Main', 'file', 'upload foto from camera / gallery', 11),
--   (1, 'LAINNYA', 'Speedtest Bandwidth Backup', 'file', 'upload foto from camera / gallery', 12),
--   (1, 'LAINNYA', 'Foto Bersama PIC', 'file', 'upload foto from camera / gallery', 13),
--   (1, 'LAINNYA', 'Foto Lokasi Satker', 'file', 'upload foto from camera / gallery', 14);




ALTER TABLE oki_site_ba_template
  ADD COLUMN default_perangkat_id INT NULL AFTER template_type;
 
ALTER TABLE oki_site_ba_template
  ADD FOREIGN KEY (default_perangkat_id) REFERENCES oki_perangkat(id) ON DELETE SET NULL;




