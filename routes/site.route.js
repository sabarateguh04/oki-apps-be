const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const FIELDS = [
  'customer_id', 'kode_site', 'site_name', 'kategori', 'latitude', 'longitude',
  'provinsi', 'kota', 'kecamatan', 'kelurahan', 'alamat_detail',
  'keterangan_pekerjaan', 'status_projek', 'status_gangguan',
];

// Semua endpoint di bawah wajib login (staff manapun boleh LIHAT data site —
// dipakai form-order.html buat auto-isi lokasi pas bikin tiket)
router.use(requireAuth);

/* GET /api/sites?customer_id=&search=
   customer_id -> filter site milik 1 customer (dipakai dropdown form-order)
   search      -> cari di kode_site / site_name (buat dropdown yg bisa diketik) */
router.get('/', async (req, res) => {
  const { customer_id, search } = req.query;
  try {
    let sql = `
      SELECT s.*, c.nama_perusahaan
      FROM oki_customer_sites s
      JOIN oki_customers c ON c.id = s.customer_id
      WHERE 1=1`;
    const params = [];
    if (customer_id) { sql += ` AND s.customer_id = ?`; params.push(customer_id); }
    if (search) { sql += ` AND (s.kode_site LIKE ? OR s.site_name LIKE ?)`; params.push(`%${search}%`, `%${search}%`); }
    sql += ` ORDER BY s.site_name ASC`;

    const [rows] = await pool.query(sql, params);
    return res.json({ success: true, sites: rows });
  } catch (e) {
    console.error('[SITE list]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* GET /api/sites/:id */
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT s.*, c.nama_perusahaan FROM oki_customer_sites s
       JOIN oki_customers c ON c.id = s.customer_id WHERE s.id = ?`,
      [req.params.id],
    );
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Site tidak ditemukan' });
    return res.json({ success: true, site: rows[0] });
  } catch (e) {
    console.error('[SITE detail]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* POST /api/sites — hanya ADMIN yang boleh kelola master data */
router.post('/', requireRole('ADMIN'), async (req, res) => {
  const b = req.body;
  if (!b.customer_id || !b.kode_site || !b.site_name) {
    return res.status(400).json({ success: false, message: 'customer_id, kode_site, dan site_name wajib diisi' });
  }
  try {
    const values = FIELDS.map(f => (b[f] === undefined || b[f] === '' ? null : b[f]));
    const [result] = await pool.query(
      `INSERT INTO oki_customer_sites (${FIELDS.join(', ')}) VALUES (${FIELDS.map(() => '?').join(', ')})`,
      values,
    );
    return res.json({ success: true, siteId: result.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'Kode site ini sudah dipakai untuk customer yang sama' });
    }
    console.error('[SITE create]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* PUT /api/sites/:id — hanya ADMIN */
router.put('/:id', requireRole('ADMIN'), async (req, res) => {
  const b = req.body;
  try {
    const values = FIELDS.map(f => (b[f] === undefined || b[f] === '' ? null : b[f]));
    await pool.query(
      `UPDATE oki_customer_sites SET ${FIELDS.map(f => `${f}=?`).join(', ')} WHERE id = ?`,
      [...values, req.params.id],
    );
    return res.json({ success: true, message: 'Site berhasil diupdate' });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'Kode site ini sudah dipakai untuk customer yang sama' });
    }
    console.error('[SITE update]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* DELETE /api/sites/:id — hanya ADMIN */
router.delete('/:id', requireRole('ADMIN'), async (req, res) => {
  try {
    // Jangan izinkan hapus site yang masih dipakai order (integritas data & histori lokasi)
    const [orders] = await pool.query(`SELECT COUNT(*) AS n FROM oki_orders WHERE site_id = ?`, [req.params.id]);
    if (orders[0].n > 0) {
      return res.status(409).json({
        success: false,
        message: `Site ini masih dipakai di ${orders[0].n} order, tidak bisa dihapus. Nonaktifkan lewat status projek NON_ACTIVE kalau memang sudah gak dipakai lagi.`,
      });
    }
    await pool.query(`DELETE FROM oki_customer_sites WHERE id = ?`, [req.params.id]);
    return res.json({ success: true, message: 'Site berhasil dihapus' });
  } catch (e) {
    console.error('[SITE delete]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;