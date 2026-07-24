const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

// mergeParams: true -- WAJIB, biar :customerId dari path mounting di
// server.js (lihat instruksi pemasangan di bawah) bisa kebaca di sini.
const router = express.Router({ mergeParams: true });
router.use(requireAuth);

const TEMPLATE_FIELDS = ['category', 'template_name', 'template_type', 'note_ba', 'urutan'];

/* GET /api/customers/:customerId/ba
   Balikin null (bukan 404) kalau customer belum punya BA -- ini KONDISI
   NORMAL, bukan error, karena banyak customer memang belum pakai BA. */
router.get('/', async (req, res) => {
  try {
    const [[ba]] = await pool.query(
      `SELECT * FROM oki_customers_ba WHERE id_customer = ?`,
      [req.params.customerId],
    );
    if (!ba) return res.json({ success: true, ba: null, templates: [] });

    const [templates] = await pool.query(
      `SELECT * FROM oki_customers_ba_template WHERE id_customers_ba = ? ORDER BY urutan ASC, id ASC`,
      [ba.id],
    );
    return res.json({ success: true, ba, templates });
  } catch (e) {
    console.error('[CUSTOMER_BA get]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* POST /api/customers/:customerId/ba — HANYA ADMIN
   Bikin master BA baru buat customer ini. Gagal kalau customer ini
   SUDAH punya BA (1 customer cuma boleh 1 BA -- lihat error ER_DUP_ENTRY). */
router.post('/', requireRole('ADMIN'), async (req, res) => {
  const { ba_name } = req.body;
  if (!ba_name) return res.status(400).json({ success: false, message: 'ba_name wajib diisi' });
  try {
    const [result] = await pool.query(
      `INSERT INTO oki_customers_ba (id_customer, ba_name) VALUES (?, ?)`,
      [req.params.customerId, ba_name],
    );
    return res.json({ success: true, baId: result.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'Customer ini sudah punya BA. Edit yang sudah ada, atau hapus dulu kalau mau ganti nama BA.' });
    }
    console.error('[CUSTOMER_BA create]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* PUT /api/customers/:customerId/ba — HANYA ADMIN (ganti nama BA) */
router.put('/', requireRole('ADMIN'), async (req, res) => {
  const { ba_name } = req.body;
  if (!ba_name) return res.status(400).json({ success: false, message: 'ba_name wajib diisi' });
  try {
    const [result] = await pool.query(
      `UPDATE oki_customers_ba SET ba_name = ? WHERE id_customer = ?`,
      [ba_name, req.params.customerId],
    );
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Customer ini belum punya BA' });
    return res.json({ success: true, message: 'Nama BA berhasil diupdate' });
  } catch (e) {
    console.error('[CUSTOMER_BA update]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* DELETE /api/customers/:customerId/ba — HANYA ADMIN
   Hapus BA + semua template item-nya (CASCADE). Order yang SUDAH DIBUAT
   sebelumnya TIDAK terpengaruh -- checklist-nya sudah ke-snapshot
   terpisah di oki_order_ba_checklist. */
router.delete('/', requireRole('ADMIN'), async (req, res) => {
  try {
    const [result] = await pool.query(`DELETE FROM oki_customers_ba WHERE id_customer = ?`, [req.params.customerId]);
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Customer ini belum punya BA' });
    return res.json({ success: true, message: 'BA berhasil dihapus. Order lama yang sudah pakai BA ini checklist-nya tetap tersimpan.' });
  } catch (e) {
    console.error('[CUSTOMER_BA delete]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* POST /api/customers/:customerId/ba/template — HANYA ADMIN
   Tambah 1 item checklist. Customer HARUS sudah punya BA dulu. */
router.post('/template', requireRole('ADMIN'), async (req, res) => {
  const b = req.body;
  if (!b.category || !b.template_name || !b.template_type) {
    return res.status(400).json({ success: false, message: 'category, template_name, dan template_type wajib diisi' });
  }
  if (!['file', 'text'].includes(b.template_type)) {
    return res.status(400).json({ success: false, message: "template_type harus 'file' atau 'text'" });
  }
  try {
    const [[ba]] = await pool.query(`SELECT id FROM oki_customers_ba WHERE id_customer = ?`, [req.params.customerId]);
    if (!ba) return res.status(404).json({ success: false, message: 'Customer ini belum punya BA -- bikin BA-nya dulu' });

    const [result] = await pool.query(
      `INSERT INTO oki_customers_ba_template (id_customers_ba, category, template_name, template_type, note_ba, urutan)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [ba.id, b.category, b.template_name, b.template_type, b.note_ba || null, b.urutan || 0],
    );
    return res.json({ success: true, templateId: result.insertId });
  } catch (e) {
    console.error('[CUSTOMER_BA template create]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* PUT /api/customers/:customerId/ba/template/:templateId — HANYA ADMIN */
router.put('/template/:templateId', requireRole('ADMIN'), async (req, res) => {
  const b = req.body;
  try {
    const sets = TEMPLATE_FIELDS.filter(f => b[f] !== undefined);
    if (sets.length === 0) return res.status(400).json({ success: false, message: 'Tidak ada field yang diupdate' });
    const [result] = await pool.query(
      `UPDATE oki_customers_ba_template SET ${sets.map(f => `${f}=?`).join(', ')} WHERE id = ?`,
      [...sets.map(f => b[f]), req.params.templateId],
    );
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Item template tidak ditemukan' });
    return res.json({ success: true, message: 'Item checklist berhasil diupdate' });
  } catch (e) {
    console.error('[CUSTOMER_BA template update]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* DELETE /api/customers/:customerId/ba/template/:templateId — HANYA ADMIN */
router.delete('/template/:templateId', requireRole('ADMIN'), async (req, res) => {
  try {
    await pool.query(`DELETE FROM oki_customers_ba_template WHERE id = ?`, [req.params.templateId]);
    return res.json({ success: true, message: 'Item checklist berhasil dihapus' });
  } catch (e) {
    console.error('[CUSTOMER_BA template delete]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;