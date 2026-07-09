const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { emitToDashboard } = require('../socket');

const router = express.Router();

/* GET /api/technicians?status=READY */
router.get('/', async (req, res) => {
  const { status } = req.query;
  try {
    let sql = `SELECT id, username, nama, no_hp, email, skill, status,
                      latitude, longitude, last_location_at, is_active, created_at
               FROM oki_technicians WHERE is_active = 1`;
    const params = [];
    if (status) { sql += ` AND status = ?`; params.push(status); }
    sql += ` ORDER BY nama ASC`;
    const [rows] = await pool.query(sql, params);
    return res.json({ success: true, technicians: rows });
  } catch (e) {
    console.error('[TECH list]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* GET /api/technicians/:id */
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, username, nama, no_hp, email, skill, status, latitude, longitude,
              last_location_at, is_active, created_at
       FROM oki_technicians WHERE id = ?`,
      [req.params.id],
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Teknisi tidak ditemukan' });

    // Sekalian kasih ringkasan performa (dipakai halaman Profile Teknisi)
    const [perf] = await pool.query(
      `SELECT
         COUNT(*) AS total_order,
         SUM(status = 'DONE') AS total_selesai,
         AVG(TIMESTAMPDIFF(MINUTE, assigned_at, selesai_at)) AS avg_durasi_menit
       FROM oki_orders WHERE technician_id = ?`,
      [req.params.id],
    );

    return res.json({ success: true, technician: rows[0], performance: perf[0] });
  } catch (e) {
    console.error('[TECH detail]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* POST /api/technicians */
router.post('/', async (req, res) => {
  const { username, password, nama, no_hp, email, skill } = req.body;
  if (!username || !password || !nama) {
    return res.status(400).json({ success: false, message: 'username, password, nama wajib diisi' });
  }
  try {
    const [existing] = await pool.query(`SELECT id FROM oki_technicians WHERE username = ?`, [username]);
    if (existing.length > 0) {
      return res.status(409).json({ success: false, message: 'Username sudah dipakai' });
    }
    const hash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      `INSERT INTO oki_technicians (username, password, nama, no_hp, email, skill) VALUES (?, ?, ?, ?, ?, ?)`,
      [username, hash, nama, no_hp || null, email || null, skill || null],
    );
    return res.json({ success: true, technicianId: result.insertId });
  } catch (e) {
    console.error('[TECH create]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* PUT /api/technicians/:id */
router.put('/:id', async (req, res) => {
  const { nama, no_hp, email, skill, is_active } = req.body;
  try {
    await pool.query(
      `UPDATE oki_technicians SET nama=?, no_hp=?, email=?, skill=?, is_active=? WHERE id = ?`,
      [nama, no_hp, email, skill, is_active === undefined ? 1 : is_active, req.params.id],
    );
    return res.json({ success: true, message: 'Teknisi berhasil diupdate' });
  } catch (e) {
    console.error('[TECH update]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/technicians/:id/status
   Toggle status teknisi. Ini yang dipencet di halaman "Profile Teknisi"
   buat masuk mode READY (siap jalan) — begitu READY, mobile app mulai
   ngirim GPS tiap 30 detik lewat endpoint /location di bawah.
   body: { status: 'OFFLINE' | 'READY' | 'ON_DUTY' }
═══════════════════════════════════════════════════ */
router.post('/:id/status', async (req, res) => {
  const { status } = req.body;
  if (!['OFFLINE', 'READY', 'ON_DUTY'].includes(status)) {
    return res.status(400).json({ success: false, message: 'status tidak valid' });
  }
  try {
    await pool.query(`UPDATE oki_technicians SET status = ? WHERE id = ?`, [status, req.params.id]);
    emitToDashboard('technician-status', { technicianId: Number(req.params.id), status });
    return res.json({ success: true, message: `Status diubah ke ${status}` });
  } catch (e) {
    console.error('[TECH status]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/technicians/:id/location
   GPS ping — dipanggil mobile app tiap 30 detik SELAMA status READY
   (atau ON_DUTY, saat lagi otw ke lokasi order). Kalau status OFFLINE,
   ping ditolak (gak ada gunanya nyimpen lokasi teknisi yang lagi gak aktif).
   body: { latitude, longitude, orderId? }
═══════════════════════════════════════════════════ */
router.post('/:id/location', async (req, res) => {
  const { latitude, longitude, orderId } = req.body;
  if (latitude === undefined || longitude === undefined) {
    return res.status(400).json({ success: false, message: 'latitude & longitude wajib diisi' });
  }

  try {
    const [rows] = await pool.query(`SELECT status FROM oki_technicians WHERE id = ?`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Teknisi tidak ditemukan' });

    if (rows[0].status === 'OFFLINE') {
      return res.status(409).json({
        success: false,
        message: 'Teknisi berstatus OFFLINE — set status ke READY dulu sebelum kirim lokasi',
      });
    }

    const now = new Date();
    await pool.query(
      `UPDATE oki_technicians SET latitude=?, longitude=?, last_location_at=? WHERE id=?`,
      [latitude, longitude, now, req.params.id],
    );
    await pool.query(
      `INSERT INTO oki_technician_locations (technician_id, order_id, latitude, longitude) VALUES (?, ?, ?, ?)`,
      [req.params.id, orderId || null, latitude, longitude],
    );

    emitToDashboard('technician-location', {
      technicianId: Number(req.params.id), latitude, longitude, orderId: orderId || null, recordedAt: now,
    });

    return res.json({ success: true });
  } catch (e) {
    console.error('[TECH location]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;