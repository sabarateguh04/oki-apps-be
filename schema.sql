-- ═══════════════════════════════════════════════════════════════════
-- OKI MAINTENANCE SYSTEM — SCHEMA FINAL TERKONSOLIDASI
--
-- File ini GANTIIN semua file berikut (jangan dipakai lagi kalau udah
-- pakai file ini):
--   schema.sql, schema_ba_addon.sql, schema_notif_addon.sql,
--   schema_ba_revisi_addon.sql, schema_site_ba_perangkat_addon.sql,
--   schema_default_perangkat_addon.sql, schema_final_site_ba_perangkat.sql
--
-- Semua kolom yang sebelumnya nempel lewat ALTER TABLE terpisah sekarang
-- langsung ada di CREATE TABLE masing-masing -- gak ada lagi ALTER
-- setelah CREATE, jadi gak ada lagi masalah urutan/FK pas mau di-drop.
--
-- ⚠️  RESET TOTAL — ini beneran DROP semua tabel oki_* lalu bikin ulang
--     dari nol. SEMUA DATA HILANG. Backup dulu kalau perlu:
--       mysqldump -u root -p test > backup_sebelum_reset.sql
--
-- CARA JALANIN (WAJIB sekali jalan utuh, jangan baris per baris manual):
--   mysql -u root -p test < schema_master.sql
-- ═══════════════════════════════════════════════════════════════════

CREATE DATABASE IF NOT EXISTS test
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE test;

-- FK checks dimatikan dari sini sampai akhir file -- ini yang bikin drop
-- ATAUPUN create tabel dengan FK ke tabel yang belum ada di baris
-- sebelumnya jadi aman, gak perlu mikirin urutan manual.
SET FOREIGN_KEY_CHECKS = 0;

-- ───────────────────────────────────────────────────────────
-- DROP semua tabel oki_* (urutan gak masalah krn FK check off)
-- ───────────────────────────────────────────────────────────
DROP TABLE IF EXISTS
  oki_order_ba_checklist,
  oki_order_files,
  oki_order_technicians,
  oki_order_biaya,
  oki_order_kebutuhan,
  oki_order_timeline,
  oki_technician_locations,
  oki_orders,
  oki_site_ba_template,
  oki_site_ba,
  oki_perangkat,
  oki_customer_sites,
  oki_technicians,
  oki_customers,
  oki_users,
  -- nama lama (kalau masih ada dari versi sebelum BA pindah ke level site)
  oki_customers_ba_template,
  oki_customers_ba;

-- ───────────────────────────────────────────────────────────
-- 1. USERS — staff internal (admin, atasan/approver, finance, dispatcher)
-- ───────────────────────────────────────────────────────────
CREATE TABLE oki_users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(100) NOT NULL UNIQUE,
  password      VARCHAR(255) NOT NULL,
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
-- 3. CUSTOMER_SITES — titik lokasi kerja terdaftar per customer.
--    Satu-satunya sumber lokasi buat order (site_id di oki_orders).
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
-- 4. TECHNICIANS
--    fcm_token: token push notification HP teknisi (dipakai push.js)
-- ───────────────────────────────────────────────────────────
CREATE TABLE oki_technicians (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  username        VARCHAR(100) NOT NULL UNIQUE,
  password        VARCHAR(255) NOT NULL,
  nama            VARCHAR(150) NOT NULL,
  no_hp           VARCHAR(30),
  email           VARCHAR(150),
  skill           VARCHAR(150) NULL,
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
  fcm_token       VARCHAR(500) NULL,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ───────────────────────────────────────────────────────────
-- 5. MASTER PERANGKAT — inventaris per unit fisik (SN unik).
--    site_id diisi kalau status TERPAKAI (lagi kepasang di site mana).
-- ───────────────────────────────────────────────────────────
CREATE TABLE oki_perangkat (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  nama_perangkat    VARCHAR(200) NOT NULL,
  kategori          VARCHAR(100) NULL,
  merk              VARCHAR(100) NULL,
  model             VARCHAR(100) NULL,
  serial_number     VARCHAR(150) NOT NULL,
  spesifikasi       TEXT NULL,
  status            ENUM('TERSEDIA','TERPAKAI','RUSAK','MAINTENANCE') NOT NULL DEFAULT 'TERSEDIA',
  site_id           INT NULL,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_serial_number (serial_number),
  FOREIGN KEY (site_id) REFERENCES oki_customer_sites(id) ON DELETE SET NULL,
  INDEX idx_perangkat_status (status)
) ENGINE=InnoDB;

-- ───────────────────────────────────────────────────────────
-- 6. MASTER BA per SITE (1 site = 1 BA aktif)
-- ───────────────────────────────────────────────────────────
CREATE TABLE oki_site_ba (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  id_site       INT NOT NULL,
  ba_name       VARCHAR(200) NOT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_site_ba (id_site),
  FOREIGN KEY (id_site) REFERENCES oki_customer_sites(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ───────────────────────────────────────────────────────────
-- 7. TEMPLATE CHECKLIST BA
--    default_perangkat_id: unit yang emang udah/akan terpasang di site
--    ini -- otomatis di-copy jadi expected_perangkat_id tiap order baru
--    (lihat snapshotBaChecklist di order.route.js), jadi gak perlu
--    assign ulang manual tiap bikin tiket (termasuk tiket maintenance).
-- ───────────────────────────────────────────────────────────
CREATE TABLE oki_site_ba_template (
  id                    INT AUTO_INCREMENT PRIMARY KEY,
  id_site_ba            INT NOT NULL,
  category              VARCHAR(100) NOT NULL,
  template_name         VARCHAR(200) NOT NULL,
  template_type         ENUM('file','text') NOT NULL DEFAULT 'file',
  default_perangkat_id  INT NULL,
  note_ba               VARCHAR(255) NULL,
  urutan                INT NOT NULL DEFAULT 0,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (id_site_ba) REFERENCES oki_site_ba(id) ON DELETE CASCADE,
  FOREIGN KEY (default_perangkat_id) REFERENCES oki_perangkat(id) ON DELETE SET NULL,
  INDEX idx_site_ba_template (id_site_ba)
) ENGINE=InnoDB;

-- ───────────────────────────────────────────────────────────
-- 8. ORDERS — inti sistem
-- ───────────────────────────────────────────────────────────
CREATE TABLE oki_orders (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  order_no        VARCHAR(20) NOT NULL UNIQUE,
  customer_id     INT NOT NULL,
  site_id         INT NULL,

  category        ENUM('PREVENTIVE','CORRECTIVE','INSTALLATION','INSPECTION') NOT NULL DEFAULT 'CORRECTIVE',
  priority        ENUM('LOW','MEDIUM','HIGH') NOT NULL DEFAULT 'MEDIUM',
  description     TEXT,

  wilayah                 VARCHAR(150) NULL,
  alamat_detail           TEXT NULL,
  lokasi_lat              DECIMAL(10,7) NULL,
  lokasi_lng              DECIMAL(10,7) NULL,
  tanggal_mulai           DATE NULL,
  tanggal_selesai_target  DATE NULL,

  status          ENUM('NEW','ASSIGNED','ON_THE_WAY','IN_PROGRESS','DONE','CLOSED','REJECTED','CANCELLED')
                  NOT NULL DEFAULT 'NEW',

  approval_status ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
  approved_by     INT NULL,
  approved_at     DATETIME NULL,
  approval_note   VARCHAR(255) NULL,

  assigned_by     INT NULL,
  assigned_at     DATETIME NULL,

  biaya_jasa      DECIMAL(14,2) NOT NULL DEFAULT 0,
  biaya_sparepart DECIMAL(14,2) NOT NULL DEFAULT 0,
  biaya_transport DECIMAL(14,2) NOT NULL DEFAULT 0,

  created_by      INT NOT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  selesai_at      DATETIME NULL,

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
-- 9. RIWAYAT GPS TEKNISI
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
-- 10. ORDER_TIMELINE — log aktivitas per order.
--     notif_roles: comma-separated role ('ADMIN,FINANCE' dst) yang
--     relevan dinotifikasi buat baris ini -- NULL artinya sengaja gak
--     ada yang dinotif (masih tetep muncul di Timeline, cuma gak di bell).
-- ───────────────────────────────────────────────────────────
CREATE TABLE oki_order_timeline (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_id    INT NOT NULL,
  event_type  VARCHAR(50) NOT NULL,
  note        VARCHAR(500) NULL,
  actor_type  ENUM('USER','TECHNICIAN','SYSTEM') NOT NULL DEFAULT 'SYSTEM',
  actor_id    INT NULL,
  notif_roles VARCHAR(100) NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES oki_orders(id) ON DELETE CASCADE,
  INDEX idx_order_time (order_id, created_at),
  INDEX idx_timeline_created (created_at)
) ENGINE=InnoDB;

-- ───────────────────────────────────────────────────────────
-- 11. KEBUTUHAN PRA-ASSIGN
-- ───────────────────────────────────────────────────────────
CREATE TABLE oki_order_kebutuhan (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  order_id        INT NOT NULL,
  nama_item       VARCHAR(200) NOT NULL,
  qty             INT NOT NULL DEFAULT 1,
  estimasi_harga  DECIMAL(14,2) NULL,
  status          ENUM('PENDING','DIBELI') NOT NULL DEFAULT 'PENDING',
  keterangan      VARCHAR(255) NULL,
  bukti_url       VARCHAR(500) NULL,
  dibeli_by       INT NULL,
  dibeli_at       DATETIME NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES oki_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (dibeli_by) REFERENCES oki_users(id)
) ENGINE=InnoDB;

-- ───────────────────────────────────────────────────────────
-- 12. RINCIAN BIAYA
-- ───────────────────────────────────────────────────────────
CREATE TABLE oki_order_biaya (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  order_id        INT NOT NULL,
  jenis           ENUM('JASA','TRANSPORT','MATERIAL','LAINNYA') NOT NULL DEFAULT 'LAINNYA',
  deskripsi       VARCHAR(200) NULL,
  jumlah          DECIMAL(14,2) NOT NULL DEFAULT 0,
  timing_bayar    ENUM('SEBELUM','SESUDAH') NOT NULL DEFAULT 'SESUDAH',
  status          ENUM('PENDING','DONE') NOT NULL DEFAULT 'PENDING',
  paid_by         INT NULL,
  paid_at         DATETIME NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES oki_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (paid_by) REFERENCES oki_users(id)
) ENGINE=InnoDB;

-- ───────────────────────────────────────────────────────────
-- 13. TEKNISI PER ORDER
-- ───────────────────────────────────────────────────────────
CREATE TABLE oki_order_technicians (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  order_id        INT NOT NULL,
  technician_id   INT NOT NULL,
  status          ENUM('PLANNED','ACCEPTED','REJECTED','ASSIGNED') NOT NULL DEFAULT 'PLANNED',
  response_note   VARCHAR(255) NULL,
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
-- 14. FILE / BUKTI — generik semua jenis lampiran & bukti.
--     kategori PEKERJAAN_BA = bukti checklist BA tipe file (terpisah
--     dari PEKERJAAN yang upload bebas biasa).
-- ───────────────────────────────────────────────────────────
CREATE TABLE oki_order_files (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  order_id        INT NOT NULL,
  kategori        ENUM('LAMPIRAN','BIAYA','KEBUTUHAN','PEKERJAAN','PEKERJAAN_BA') NOT NULL,
  ref_id          INT NULL,
  judul           VARCHAR(200) NULL,
  file_url        VARCHAR(500) NOT NULL,
  uploaded_by                INT NULL,
  uploaded_by_technician_id  INT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES oki_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES oki_users(id),
  FOREIGN KEY (uploaded_by_technician_id) REFERENCES oki_technicians(id)
) ENGINE=InnoDB;

-- ───────────────────────────────────────────────────────────
-- 15. SNAPSHOT CHECKLIST BA PER ORDER
--     expected_perangkat_id / match_status / mismatch_note: validasi
--     SN teknisi vs unit yang di-assign (lihat order.route.js).
--     revision_note: alasan admin pas minta teknisi isi ulang.
-- ───────────────────────────────────────────────────────────
CREATE TABLE oki_order_ba_checklist (
  id                        INT AUTO_INCREMENT PRIMARY KEY,
  order_id                  INT NOT NULL,
  template_id               INT NULL,
  expected_perangkat_id     INT NULL,
  category                  VARCHAR(100) NOT NULL,
  template_name             VARCHAR(200) NOT NULL,
  template_type             ENUM('file','text') NOT NULL,
  note_ba                   VARCHAR(255) NULL,
  revision_note             VARCHAR(255) NULL,
  urutan                    INT NOT NULL DEFAULT 0,
  status                    ENUM('PENDING','DONE') NOT NULL DEFAULT 'PENDING',
  match_status              ENUM('N/A','MATCH','MISMATCH') NOT NULL DEFAULT 'N/A',
  mismatch_note             VARCHAR(255) NULL,
  text_value                VARCHAR(500) NULL,
  file_id                   INT NULL,
  filled_by_technician_id   INT NULL,
  filled_at                 DATETIME NULL,
  created_at                DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES oki_orders(id) ON DELETE CASCADE,
  FOREIGN KEY (template_id) REFERENCES oki_site_ba_template(id) ON DELETE SET NULL,
  FOREIGN KEY (expected_perangkat_id) REFERENCES oki_perangkat(id) ON DELETE SET NULL,
  FOREIGN KEY (file_id) REFERENCES oki_order_files(id) ON DELETE SET NULL,
  FOREIGN KEY (filled_by_technician_id) REFERENCES oki_technicians(id),
  INDEX idx_checklist_order (order_id)
) ENGINE=InnoDB;

-- FK checks dinyalain lagi -- semua tabel udah selesai dibikin.
SET FOREIGN_KEY_CHECKS = 1;

-- ───────────────────────────────────────────────────────────
-- SEED DATA MINIMAL (password semua akun contoh: "password123")
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