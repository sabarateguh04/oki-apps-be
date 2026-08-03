const express = require('express');
const pool = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');

// mergeParams: true -- biar :siteId dari path mounting di server.js
// (app.use('/api/sites/:siteId/ba', ...)) kebaca di sini.
const router = express.Router({ mergeParams: true });
router.use(requireAuth);

const TEMPLATE_FIELDS = ['category', 'template_name', 'template_type', 'note_ba', 'urutan', 'default_perangkat_id'];

/* GET /api/sites/:siteId/ba
   Balikin null (bukan 404) kalau site belum punya BA -- KONDISI NORMAL,
   bukan error, banyak site memang belum pakai BA. */
router.get('/', async (req, res) => {
  try {
    const [[ba]] = await pool.query(
      `SELECT * FROM oki_site_ba WHERE id_site = ?`,
      [req.params.siteId],
    );
    if (!ba) return res.json({ success: true, ba: null, templates: [] });

    const [templates] = await pool.query(
      `SELECT t.*, p.nama_perangkat AS default_perangkat_name, p.serial_number AS default_serial_number
       FROM oki_site_ba_template t
       LEFT JOIN oki_perangkat p ON p.id = t.default_perangkat_id
       WHERE t.id_site_ba = ? ORDER BY t.urutan ASC, t.id ASC`,
      [ba.id],
    );
    return res.json({ success: true, ba, templates });
  } catch (e) {
    console.error('[SITE_BA get]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* POST /api/sites/:siteId/ba — HANYA ADMIN */
router.post('/', requireRole('ADMIN'), async (req, res) => {
  const { ba_name } = req.body;
  if (!ba_name) return res.status(400).json({ success: false, message: 'ba_name wajib diisi' });
  try {
    const [result] = await pool.query(
      `INSERT INTO oki_site_ba (id_site, ba_name) VALUES (?, ?)`,
      [req.params.siteId, ba_name],
    );
    return res.json({ success: true, baId: result.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ success: false, message: 'Site ini sudah punya BA. Edit yang sudah ada, atau hapus dulu kalau mau ganti nama BA.' });
    }
    console.error('[SITE_BA create]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* PUT /api/sites/:siteId/ba — HANYA ADMIN */
router.put('/', requireRole('ADMIN'), async (req, res) => {
  const { ba_name } = req.body;
  if (!ba_name) return res.status(400).json({ success: false, message: 'ba_name wajib diisi' });
  try {
    const [result] = await pool.query(
      `UPDATE oki_site_ba SET ba_name = ? WHERE id_site = ?`,
      [ba_name, req.params.siteId],
    );
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Site ini belum punya BA' });
    return res.json({ success: true, message: 'Nama BA berhasil diupdate' });
  } catch (e) {
    console.error('[SITE_BA update]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* DELETE /api/sites/:siteId/ba — HANYA ADMIN */
router.delete('/', requireRole('ADMIN'), async (req, res) => {
  try {
    const [result] = await pool.query(`DELETE FROM oki_site_ba WHERE id_site = ?`, [req.params.siteId]);
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Site ini belum punya BA' });
    return res.json({ success: true, message: 'BA berhasil dihapus. Order lama yang sudah pakai BA ini checklist-nya tetap tersimpan.' });
  } catch (e) {
    console.error('[SITE_BA delete]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* POST /api/sites/:siteId/ba/template — HANYA ADMIN */
router.post('/template', requireRole('ADMIN'), async (req, res) => {
  const b = req.body;
  if (!b.category || !b.template_name || !b.template_type) {
    return res.status(400).json({ success: false, message: 'category, template_name, dan template_type wajib diisi' });
  }
  if (!['file', 'text'].includes(b.template_type)) {
    return res.status(400).json({ success: false, message: "template_type harus 'file' atau 'text'" });
  }
  try {
    const [[ba]] = await pool.query(`SELECT id FROM oki_site_ba WHERE id_site = ?`, [req.params.siteId]);
    if (!ba) return res.status(404).json({ success: false, message: 'Site ini belum punya BA -- bikin BA-nya dulu' });

    const [result] = await pool.query(
      `INSERT INTO oki_site_ba_template (id_site_ba, category, template_name, template_type, note_ba, urutan, default_perangkat_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [ba.id, b.category, b.template_name, b.template_type, b.note_ba || null, b.urutan || 0, b.default_perangkat_id || null],
    );
    return res.json({ success: true, templateId: result.insertId });
  } catch (e) {
    console.error('[SITE_BA template create]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* PUT /api/sites/:siteId/ba/template/:templateId — HANYA ADMIN */
router.put('/template/:templateId', requireRole('ADMIN'), async (req, res) => {
  const b = req.body;
  try {
    const sets = TEMPLATE_FIELDS.filter(f => b[f] !== undefined);
    if (sets.length === 0) return res.status(400).json({ success: false, message: 'Tidak ada field yang diupdate' });
    const [result] = await pool.query(
      `UPDATE oki_site_ba_template SET ${sets.map(f => `${f}=?`).join(', ')} WHERE id = ?`,
      [...sets.map(f => b[f]), req.params.templateId],
    );
    if (result.affectedRows === 0) return res.status(404).json({ success: false, message: 'Item template tidak ditemukan' });
    return res.json({ success: true, message: 'Item checklist berhasil diupdate' });
  } catch (e) {
    console.error('[SITE_BA template update]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* DELETE /api/sites/:siteId/ba/template/:templateId — HANYA ADMIN */
router.delete('/template/:templateId', requireRole('ADMIN'), async (req, res) => {
  try {
    await pool.query(`DELETE FROM oki_site_ba_template WHERE id = ?`, [req.params.templateId]);
    return res.json({ success: true, message: 'Item checklist berhasil dihapus' });
  } catch (e) {
    console.error('[SITE_BA template delete]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* POST /api/sites/:siteId/ba/clone — HANYA ADMIN */
router.post('/clone', requireRole('ADMIN'), async (req, res) => {
  const { fromSiteId } = req.body;
  const toSiteId = req.params.siteId;

  if (!fromSiteId) {
    return res.status(400).json({ success: false, message: 'fromSiteId (ID Site asal) wajib ditentukan' });
  }
  if (String(fromSiteId) === String(toSiteId)) {
    return res.status(400).json({ success: false, message: 'Site asal dan tujuan tidak boleh sama' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // 1. Ambil data BA asal
    const [[fromBa]] = await conn.query(
      `SELECT * FROM oki_site_ba WHERE id_site = ?`,
      [fromSiteId]
    );
    if (!fromBa) {
      throw new Error('Site asal belum memiliki Master BA');
    }

    // 2. Ambil templates dari BA asal
    const [fromTemplates] = await conn.query(
      `SELECT * FROM oki_site_ba_template WHERE id_site_ba = ?`,
      [fromBa.id]
    );
    if (fromTemplates.length === 0) {
      throw new Error('Site asal tidak memiliki item checklist untuk disalin');
    }

    // 3. Cek atau Buat BA tujuan
    let [[toBa]] = await conn.query(
      `SELECT * FROM oki_site_ba WHERE id_site = ?`,
      [toSiteId]
    );
    if (!toBa) {
      const [insertBaResult] = await conn.query(
        `INSERT INTO oki_site_ba (id_site, ba_name) VALUES (?, ?)`,
        [toSiteId, fromBa.ba_name]
      );
      toBa = { id: insertBaResult.insertId, ba_name: fromBa.ba_name };
    } else {
      // Hapus templates lama jika menimpa yang sudah ada
      await conn.query(
        `DELETE FROM oki_site_ba_template WHERE id_site_ba = ?`,
        [toBa.id]
      );
    }

    // 4. Salin template items (default_perangkat_id di-set NULL karena perangkat spesifik per site)
    for (const t of fromTemplates) {
      await conn.query(
        `INSERT INTO oki_site_ba_template (id_site_ba, category, template_name, template_type, note_ba, urutan, default_perangkat_id)
         VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        [toBa.id, t.category, t.template_name, t.template_type, t.note_ba, t.urutan]
      );
    }

    await conn.commit();
    return res.json({ success: true, message: `Berhasil menyalin ${fromTemplates.length} item checklist` });
  } catch (e) {
    await conn.rollback();
    console.error('[SITE_BA clone]', e.message);
    return res.status(500).json({ success: false, message: e.message || 'Server error' });
  } finally {
    conn.release();
  }
});

module.exports = router;