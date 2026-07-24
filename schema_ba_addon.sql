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