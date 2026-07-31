const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

function requireAdminOrTechnician(req, res, next) {
  if (req.user && (req.user.type === 'technician' || (req.user.type === 'staff' && req.user.role === 'ADMIN'))) {
    return next();
  }
  return res.status(403).json({ success: false, message: 'Aksi ini hanya untuk Admin atau Teknisi' });
}

const router = express.Router();
router.use(requireAuth);

const FIELDS = ['nama_perangkat', 'kategori', 'merk', 'model', 'serial_number', 'spesifikasi', 'status', 'site_id'];

/* GET /api/perangkat?status=&kategori=&site_id=&search=
   status/kategori/site_id -> filter. search -> cari di nama_perangkat/serial_number.
   Dipakai juga buat dropdown "Pre-assign unit" di halaman order (biasanya
   filter status=TERSEDIA biar cuma nawarin stok yang belum kepakai). */
router.get('/', async (req, res) => {
  const { status, kategori, site_id, search } = req.query;
  try {
    let sql = `
      SELECT p.*, s.site_name, s.kode_site, c.nama_perusahaan
      FROM oki_perangkat p
      LEFT JOIN oki_customer_sites s ON s.id = p.site_id
      LEFT JOIN oki_customers c ON c.id = s.customer_id
      WHERE 1=1`;
    const params = [];
    if (status)   { sql += ` AND p.status = ?`;   params.push(status); }
    if (kategori) { sql += ` AND p.kategori = ?`; params.push(kategori); }
    if (site_id)  { sql += ` AND p.site_id = ?`;  params.push(site_id); }
    if (search)   { sql += ` AND (p.nama_perangkat LIKE ? OR p.serial_number LIKE ?)`; params.push(`%${search}%`, `%${search}%`); }
    sql += ` ORDER BY p.nama_perangkat ASC`;

    const [rows] = await pool.query(sql, params);
    return res.json({ success: true, perangkat: rows });
  } catch (e) {
    console.error('[PERANGKAT list]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* POST /api/perangkat/bulk — Import Excel (ADMIN & TEKNISI) */
router.post('/bulk', requireAdminOrTechnician, async (req, res) => {
  const { perangkat } = req.body;
  if (!Array.isArray(perangkat) || perangkat.length === 0) {
    return res.status(400).json({ success: false, message: 'Data perangkat kosong atau tidak valid' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let inserted = 0;
    for (const b of perangkat) {
      if (!b.nama_perangkat || !b.serial_number) {
        throw new Error('Kolom Nama Perangkat dan Serial Number wajib diisi');
      }
      const values = FIELDS.map(f => {
        if (f === 'status') return b.status || 'TERSEDIA';
        return b[f] === undefined || b[f] === '' ? null : b[f];
      });
      await conn.query(
        `INSERT INTO oki_perangkat (${FIELDS.join(', ')}) VALUES (${FIELDS.map(() => '?').join(', ')})`,
        values
      );
      inserted++;
    }
    await conn.commit();
    return res.json({ success: true, message: `${inserted} perangkat berhasil diimpor` });
  } catch (e) {
    await conn.rollback();
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'Gagal impor: Terdapat Serial Number yang sudah terdaftar' });
    }
    console.error('[PERANGKAT bulk]', e.message);
    return res.status(500).json({ success: false, message: e.message || 'Server error' });
  } finally {
    conn.release();
  }
});

/* GET /api/perangkat/:id */
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.*, s.site_name, s.kode_site, c.nama_perusahaan
       FROM oki_perangkat p
       LEFT JOIN oki_customer_sites s ON s.id = p.site_id
       LEFT JOIN oki_customers c ON c.id = s.customer_id
       WHERE p.id = ?`,
      [req.params.id],
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Perangkat tidak ditemukan' });
    return res.json({ success: true, perangkat: rows[0] });
  } catch (e) {
    console.error('[PERANGKAT detail]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* POST /api/perangkat — ADMIN & TEKNISI (Mobile App) */
router.post('/', requireAdminOrTechnician, async (req, res) => {
  const b = req.body;
  if (!b.nama_perangkat || !b.serial_number) {
    return res.status(400).json({ success: false, message: 'nama_perangkat dan serial_number wajib diisi' });
  }
  try {
    const values = FIELDS.map(f => {
      if (f === 'status') return b.status || 'TERSEDIA';
      return b[f] === undefined || b[f] === '' ? null : b[f];
    });
    const [result] = await pool.query(
      `INSERT INTO oki_perangkat (${FIELDS.join(', ')}) VALUES (${FIELDS.map(() => '?').join(', ')})`,
      values,
    );
    return res.json({ success: true, perangkatId: result.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'Serial number ini sudah terdaftar di master perangkat' });
    }
    console.error('[PERANGKAT create]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* PUT /api/perangkat/:id — ADMIN & TEKNISI (Mobile App)
   Dipakai juga buat ubah status manual (mis. jadi RUSAK/MAINTENANCE,
   atau balikin ke TERSEDIA pas unit ditarik dari site). */
router.put('/:id', requireAdminOrTechnician, async (req, res) => {
  const b = req.body;
  try {
    const sets = FIELDS.filter(f => b[f] !== undefined);
    if (sets.length === 0) return res.status(400).json({ success: false, message: 'Tidak ada field yang diupdate' });
    await pool.query(
      `UPDATE oki_perangkat SET ${sets.map(f => `${f}=?`).join(', ')} WHERE id = ?`,
      [...sets.map(f => (b[f] === '' ? null : b[f])), req.params.id],
    );
    return res.json({ success: true, message: 'Perangkat berhasil diupdate' });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'Serial number ini sudah dipakai perangkat lain' });
    }
    console.error('[PERANGKAT update]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* DELETE /api/perangkat/:id — HANYA ADMIN */
router.delete('/:id', requireRole('ADMIN'), async (req, res) => {
  try {
    // Jangan izinkan hapus perangkat yang masih di-pre-assign ke checklist
    // order manapun (integritas histori checklist).
    const [refs] = await pool.query(
      `SELECT COUNT(*) AS n FROM oki_order_ba_checklist WHERE expected_perangkat_id = ?`, [req.params.id],
    );
    if (refs[0].n > 0) {
      return res.status(409).json({ success: false, message: `Perangkat ini masih ter-assign di ${refs[0].n} checklist order, tidak bisa dihapus` });
    }
    await pool.query(`DELETE FROM oki_perangkat WHERE id = ?`, [req.params.id]);
    return res.json({ success: true, message: 'Perangkat berhasil dihapus' });
  } catch (e) {
    console.error('[PERANGKAT delete]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;