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
  alamat          TEXT,
  latitude        DECIMAL(10,7) NULL,
  longitude       DECIMAL(10,7) NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
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

  category        ENUM('PREVENTIVE','CORRECTIVE','INSTALLATION','INSPECTION') NOT NULL DEFAULT 'CORRECTIVE',
  priority        ENUM('LOW','MEDIUM','HIGH') NOT NULL DEFAULT 'MEDIUM',
  description     TEXT,

  -- ── Status utama alur pekerjaan ──
  -- NEW → (approval) → ASSIGNED → ON_THE_WAY → IN_PROGRESS → DONE
  -- REJECTED / CANCELLED bisa kejadian di step manapun sebelum DONE.
  status          ENUM('NEW','ASSIGNED','ON_THE_WAY','IN_PROGRESS','DONE','REJECTED','CANCELLED')
                  NOT NULL DEFAULT 'NEW',

  -- ── CONDITION 1: Approval atasan ──
  approval_status ENUM('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
  approved_by     INT NULL,
  approved_at     DATETIME NULL,
  approval_note   VARCHAR(255) NULL,

  -- ── CONDITION 2: Pre-bayar (material/equipment) — opsional ──
  has_pre_bayar     TINYINT(1) NOT NULL DEFAULT 0,
  pre_bayar_status  ENUM('PENDING','DONE') NOT NULL DEFAULT 'PENDING',
  pre_bayar_amount  DECIMAL(14,2) NULL,
  pre_bayar_paid_at DATETIME NULL,

  -- ── CONDITION 3: Transfer jasa teknisi (cuma relevan kalau timing = SEBELUM) ──
  payment_timing              ENUM('SEBELUM','SESUDAH') NOT NULL DEFAULT 'SESUDAH',
  jasa_teknisi_transfer_status ENUM('PENDING','DONE') NOT NULL DEFAULT 'PENDING',
  jasa_teknisi_paid_at         DATETIME NULL,

  -- ── Assignment teknisi ──
  technician_id   INT NULL,
  assigned_by     INT NULL,
  assigned_at     DATETIME NULL,

  -- ── Biaya ──
  biaya_jasa      DECIMAL(14,2) NOT NULL DEFAULT 0,
  biaya_sparepart DECIMAL(14,2) NOT NULL DEFAULT 0,

  -- ── Waktu (buat SLA & analitik) ──
  created_by      INT NOT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  selesai_at      DATETIME NULL,                 -- diisi otomatis saat status → DONE

  FOREIGN KEY (customer_id)   REFERENCES oki_customers(id),
  FOREIGN KEY (technician_id) REFERENCES oki_technicians(id),
  FOREIGN KEY (approved_by)   REFERENCES oki_users(id),
  FOREIGN KEY (assigned_by)   REFERENCES oki_users(id),
  FOREIGN KEY (created_by)    REFERENCES oki_users(id),

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

INSERT INTO oki_technicians (username, password, nama, no_hp, email, skill) VALUES
  ('teknisi1', '$2b$10$.gI0Q57pTsFDt0cbQBpDb.qq2m6KPafkaQOBaQwnpp1uIbUcXnM62', 'Andi Wijaya', '081212121212', 'andi@email.com', 'Elektrikal');