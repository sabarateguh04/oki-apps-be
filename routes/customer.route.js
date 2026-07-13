const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

const FIELDS = [
  'nama_perusahaan', 'pic_nama', 'pic_hp', 'pic_email', 'alamat',
  'provinsi', 'kabupaten_kota', 'kecamatan', 'kode_pos', 'telp_perusahaan',
  'latitude', 'longitude',
];

// Semua endpoint di bawah wajib login (staff manapun boleh LIHAT data customer)
router.use(requireAuth);

/* GET /api/customers */
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT * FROM oki_customers ORDER BY nama_perusahaan ASC`);
    return res.json({ success: true, customers: rows });
  } catch (e) {
    console.error('[CUSTOMER list]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* GET /api/customers/:id */
router.get('/:id', async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT * FROM oki_customers WHERE id = ?`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Customer tidak ditemukan' });
    return res.json({ success: true, customer: rows[0] });
  } catch (e) {
    console.error('[CUSTOMER detail]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* POST /api/customers — hanya ADMIN yang boleh kelola master data */
router.post('/', requireRole('ADMIN'), async (req, res) => {
  const b = req.body;
  if (!b.nama_perusahaan) {
    return res.status(400).json({ success: false, message: 'nama_perusahaan wajib diisi' });
  }
  try {
    const values = FIELDS.map(f => (b[f] === undefined || b[f] === '' ? null : b[f]));
    const [result] = await pool.query(
      `INSERT INTO oki_customers (${FIELDS.join(', ')}) VALUES (${FIELDS.map(() => '?').join(', ')})`,
      values,
    );
    return res.json({ success: true, customerId: result.insertId });
  } catch (e) {
    console.error('[CUSTOMER create]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* PUT /api/customers/:id — hanya ADMIN */
router.put('/:id', requireRole('ADMIN'), async (req, res) => {
  const b = req.body;
  try {
    const values = FIELDS.map(f => (b[f] === undefined || b[f] === '' ? null : b[f]));
    await pool.query(
      `UPDATE oki_customers SET ${FIELDS.map(f => `${f}=?`).join(', ')} WHERE id = ?`,
      [...values, req.params.id],
    );
    return res.json({ success: true, message: 'Customer berhasil diupdate' });
  } catch (e) {
    console.error('[CUSTOMER update]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* DELETE /api/customers/:id — hanya ADMIN */
router.delete('/:id', requireRole('ADMIN'), async (req, res) => {
  try {
    // Jangan izinkan hapus customer yang masih punya order (integritas data)
    const [orders] = await pool.query(`SELECT COUNT(*) AS n FROM oki_orders WHERE customer_id = ?`, [req.params.id]);
    if (orders[0].n > 0) {
      return res.status(409).json({
        success: false,
        message: `Customer masih punya ${orders[0].n} order, tidak bisa dihapus`,
      });
    }
    await pool.query(`DELETE FROM oki_customers WHERE id = ?`, [req.params.id]);
    return res.json({ success: true, message: 'Customer berhasil dihapus' });
  } catch (e) {
    console.error('[CUSTOMER delete]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
