const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { emitToDashboard } = require('../socket');
const { requireAuth, requireRole, requireTechnician } = require('../middleware/auth');

const router = express.Router();

const PROFILE_FIELDS = [
  'nama', 'no_hp', 'email', 'skill', 'spesialisasi', 'sertifikasi', 'wilayah_kerja',
  'alamat', 'tanggal_lahir', 'no_ktp', 'nama_bank', 'no_rekening', 'nama_rekening', 'is_active',
];

const PROFILE_SELECT = `id, username, nama, no_hp, email, skill, spesialisasi, sertifikasi,
  wilayah_kerja, alamat, tanggal_lahir, no_ktp, nama_bank, no_rekening, nama_rekening,
  status, latitude, longitude, last_location_at, is_active, created_at`;

// Semua endpoint teknisi wajib login (staff ATAU teknisi yang bersangkutan buat status/lokasi)
router.use(requireAuth);

/* GET /api/technicians?status=READY — staff manapun boleh lihat */
router.get('/', async (req, res) => {
  const { status } = req.query;
  try {
    let sql = `SELECT ${PROFILE_SELECT} FROM oki_technicians WHERE is_active = 1`;
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
    const [rows] = await pool.query(`SELECT ${PROFILE_SELECT} FROM oki_technicians WHERE id = ?`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Teknisi tidak ditemukan' });

    const [perf] = await pool.query(
      `SELECT
         COUNT(ot.order_id) AS total_order,
         SUM(o.status = 'DONE') AS total_selesai,
         AVG(TIMESTAMPDIFF(MINUTE, o.assigned_at, o.selesai_at)) AS avg_durasi_menit
       FROM oki_order_technicians ot
       JOIN oki_orders o ON o.id = ot.order_id
       WHERE ot.technician_id = ? AND ot.status = 'ASSIGNED'`,
      [req.params.id],
    );

    return res.json({ success: true, technician: rows[0], performance: perf[0] });
  } catch (e) {
    console.error('[TECH detail]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* POST /api/technicians — hanya ADMIN yang boleh tambah teknisi baru */
router.post('/', requireRole('ADMIN'), async (req, res) => {
  const { username, password, ...profile } = req.body;
  if (!username || !password || !profile.nama) {
    return res.status(400).json({ success: false, message: 'username, password, nama wajib diisi' });
  }
  try {
    const [existing] = await pool.query(`SELECT id FROM oki_technicians WHERE username = ?`, [username]);
    if (existing.length > 0) {
      return res.status(409).json({ success: false, message: 'Username sudah dipakai' });
    }
    const hash = await bcrypt.hash(password, 10);
    const cols = ['username', 'password', ...PROFILE_FIELDS.filter(f => f !== 'is_active')];
    const values = cols.map(f => {
      if (f === 'username') return username;
      if (f === 'password') return hash;
      return profile[f] === undefined || profile[f] === '' ? null : profile[f];
    });
    const [result] = await pool.query(
      `INSERT INTO oki_technicians (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
      values,
    );
    return res.json({ success: true, technicianId: result.insertId });
  } catch (e) {
    console.error('[TECH create]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* PUT /api/technicians/:id — hanya ADMIN */
router.put('/:id', requireRole('ADMIN'), async (req, res) => {
  const b = req.body;
  try {
    const values = PROFILE_FIELDS.map(f => {
      if (f === 'is_active') return b.is_active === undefined ? 1 : b.is_active;
      return b[f] === undefined || b[f] === '' ? null : b[f];
    });
    await pool.query(
      `UPDATE oki_technicians SET ${PROFILE_FIELDS.map(f => `${f}=?`).join(', ')} WHERE id = ?`,
      [...values, req.params.id],
    );
    if (b.password) {
      const hash = await bcrypt.hash(b.password, 10);
      await pool.query(`UPDATE oki_technicians SET password = ? WHERE id = ?`, [hash, req.params.id]);
    }
    return res.json({ success: true, message: 'Teknisi berhasil diupdate' });
  } catch (e) {
    console.error('[TECH update]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/technicians/:id/status
   Teknisi hanya boleh ubah status DIRINYA SENDIRI.
   body: { status: 'OFFLINE' | 'READY' | 'ON_DUTY' }
═══════════════════════════════════════════════════ */
router.post('/:id/status', requireTechnician, async (req, res) => {
  const { status } = req.body;
  if (!['OFFLINE', 'READY', 'ON_DUTY'].includes(status)) {
    return res.status(400).json({ success: false, message: 'status tidak valid' });
  }
  if (Number(req.user.id) !== Number(req.params.id)) {
    return res.status(403).json({ success: false, message: 'Tidak boleh ubah status teknisi lain' });
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
   GPS ping tiap 30 detik SELAMA status READY/ON_DUTY.
   body: { latitude, longitude, orderId? }
═══════════════════════════════════════════════════ */
router.post('/:id/location', requireTechnician, async (req, res) => {
  const { latitude, longitude, orderId } = req.body;
  if (latitude === undefined || longitude === undefined) {
    return res.status(400).json({ success: false, message: 'latitude & longitude wajib diisi' });
  }
  if (Number(req.user.id) !== Number(req.params.id)) {
    return res.status(403).json({ success: false, message: 'Tidak boleh kirim lokasi atas nama teknisi lain' });
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
