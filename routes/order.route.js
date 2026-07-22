const express = require('express');
const pool = require('../db');
const { getAssignEligibility } = require('../helpers/assignEligibility');
const { emitToDashboard, emitToTechnician } = require('../socket');
const { requireAuth, requireRole, requireTechnician } = require('../middleware/auth');
const { handleUploadMultiple, publicUrlFor } = require('../middleware/upload');
const { sendPushToTechnician } = require('../push');

const router = express.Router();
router.use(requireAuth);

/* Helper: tulis satu baris ke order_timeline (log aktivitas) */
async function logTimeline(orderId, eventType, note, actorType = 'SYSTEM', actorId = null) {
  await pool.query(
    `INSERT INTO oki_order_timeline (order_id, event_type, note, actor_type, actor_id) VALUES (?, ?, ?, ?, ?)`,
    [orderId, eventType, note || null, actorType, actorId],
  );
}

async function countPendingKebutuhan(orderId) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM oki_order_kebutuhan WHERE order_id = ? AND status = 'PENDING'`,
    [orderId],
  );
  return row.n;
}

async function countPendingBiayaSebelum(orderId) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM oki_order_biaya WHERE order_id = ? AND timing_bayar = 'SEBELUM' AND status = 'PENDING'`,
    [orderId],
  );
  return row.n;
}

/* Helper: simpan banyak file upload ke oki_order_files sekaligus, balikin array url.
   uploaderType: 'USER' (staff, default) atau 'TECHNICIAN' — nentuin kolom mana
   yang keisi (uploaded_by vs uploaded_by_technician_id), karena teknisi gak
   ada di tabel oki_users. */
async function saveFiles(conn, orderId, kategori, files, uploadedBy, refId = null, judulList = null, uploaderType = 'USER') {
  const urls = [];
  for (let i = 0; i < (files || []).length; i++) {
    const url = publicUrlFor(files[i].filename);
    const judul = Array.isArray(judulList) ? (judulList[i] || null) : (judulList || null);
    await conn.query(
      `INSERT INTO oki_order_files (order_id, kategori, ref_id, judul, file_url, uploaded_by, uploaded_by_technician_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        orderId, kategori, refId, judul, url,
        uploaderType === 'USER' ? uploadedBy : null,
        uploaderType === 'TECHNICIAN' ? uploadedBy : null,
      ],
    );
    urls.push(url);
  }
  return urls;
}

/* Helper: ambil 1 order + hitung assign eligibility-nya + teknisi + kebutuhan + biaya + file */
async function getOrderWithEligibility(orderId) {
  const [rows] = await pool.query(
    `SELECT o.*, c.nama_perusahaan, c.pic_nama, c.pic_hp, c.alamat AS customer_alamat,
            c.latitude AS customer_lat, c.longitude AS customer_lng,
            s.kode_site, s.site_name, s.status_projek AS site_status_projek, s.status_gangguan AS site_status_gangguan
     FROM oki_orders o
     JOIN oki_customers c ON c.id = o.customer_id
     LEFT JOIN oki_customer_sites s ON s.id = o.site_id
     WHERE o.id = ?`,
    [orderId],
  );
  if (rows.length === 0) return null;
  const order = rows[0];

  const [technicians] = await pool.query(
    `SELECT ot.id AS relation_id, ot.status AS relation_status, ot.response_note, ot.responded_at, ot.assigned_at,
            t.id, t.nama, t.no_hp, t.email, t.spesialisasi, t.skill, t.nama_bank, t.no_rekening, t.nama_rekening
     FROM oki_order_technicians ot
     JOIN oki_technicians t ON t.id = ot.technician_id
     WHERE ot.order_id = ?
     ORDER BY ot.created_at ASC`,
    [orderId],
  );

  const [kebutuhan] = await pool.query(
    `SELECT * FROM oki_order_kebutuhan WHERE order_id = ? ORDER BY created_at ASC`, [orderId],
  );
  const [biaya] = await pool.query(
    `SELECT * FROM oki_order_biaya WHERE order_id = ? ORDER BY created_at ASC`, [orderId],
  );
  const [files] = await pool.query(
    `SELECT * FROM oki_order_files WHERE order_id = ? ORDER BY created_at ASC`, [orderId],
  );

  const pendingKebutuhan = kebutuhan.filter(k => k.status === 'PENDING').length;
  const pendingBiayaSebelum = biaya.filter(b => b.timing_bayar === 'SEBELUM' && b.status === 'PENDING').length;
  const acceptedTechCount = technicians.filter(t => t.relation_status === 'ACCEPTED').length;
  const assignedTechCount = technicians.filter(t => t.relation_status === 'ASSIGNED').length;

  return {
    ...order,
    technicians_planned: technicians.filter(t => t.relation_status === 'PLANNED'),
    technicians_accepted: technicians.filter(t => t.relation_status === 'ACCEPTED'),
    technicians_rejected: technicians.filter(t => t.relation_status === 'REJECTED'),
    technicians_assigned: technicians.filter(t => t.relation_status === 'ASSIGNED'),
    kebutuhan_pra_assign: kebutuhan.map(k => ({
      ...k,
      bukti_files: files.filter(f => f.kategori === 'KEBUTUHAN' && f.ref_id === k.id),
    })),
    rincian_biaya: biaya.map(b => ({
      ...b,
      bukti_files: files.filter(f => f.kategori === 'BIAYA' && f.ref_id === b.id),
    })),
    lampiran: files.filter(f => f.kategori === 'LAMPIRAN'),
    bukti_pekerjaan: files.filter(f => f.kategori === 'PEKERJAAN'),
    assign_eligibility: getAssignEligibility(order, pendingKebutuhan, pendingBiayaSebelum, acceptedTechCount, assignedTechCount),
  };
}

/* Redaksi data sensitif kalau yang minta adalah TEKNISI — supaya 1 teknisi
   gak bisa lihat rekening bank teknisi LAIN yang satu order sama dia, dan
   cuma lihat biaya JASA (bukti dia sendiri dibayar), bukan rincian biaya
   material/lainnya yang bukan urusannya. */
function redactForTechnician(order) {
  const stripBank = (t) => { const { nama_bank, no_rekening, nama_rekening, ...rest } = t; return rest; };
  return {
    ...order,
    technicians_planned: order.technicians_planned.map(stripBank),
    technicians_accepted: order.technicians_accepted.map(stripBank),
    technicians_rejected: order.technicians_rejected.map(stripBank),
    technicians_assigned: order.technicians_assigned.map(stripBank),
    rincian_biaya: order.rincian_biaya, // semua jenis (jasa/transport/material/lainnya) — teknisi boleh lihat status TF tiap komponen, cuma rekening kolega yang di-redact di atas
    kebutuhan_pra_assign: [], // urusan Finance, bukan konsumsi teknisi
  };
}

/* ═══════════════════════════════════════════════════
   GET /api/orders/offers/mine — HANYA TEKNISI
   Daftar tawaran tugas (PLANNED) yang nunggu direspon teknisi ini.
   PENTING: harus didaftarkan SEBELUM GET /:id biar 'offers' gak
   ketangkep jadi :id.
═══════════════════════════════════════════════════ */
router.get('/offers/mine', requireTechnician, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT o.id, o.order_no, o.category, o.priority, o.wilayah, o.description,
              o.tanggal_mulai, o.tanggal_selesai_target, c.nama_perusahaan, ot.created_at AS offered_at
       FROM oki_order_technicians ot
       JOIN oki_orders o ON o.id = ot.order_id
       JOIN oki_customers c ON c.id = o.customer_id
       WHERE ot.technician_id = ? AND ot.status = 'PLANNED'
       ORDER BY ot.created_at DESC`,
      [req.user.id],
    );
    return res.json({ success: true, offers: rows });
  } catch (e) {
    console.error('[ORDER offers/mine]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   GET /api/orders?status=&priority=&customer_id=&page=&limit=
═══════════════════════════════════════════════════ */
router.get('/', async (req, res) => {
  const { status, priority, customer_id, approval_status, technician_id, page = 1, limit = 20 } = req.query;
  const offset = (Number(page) - 1) * Number(limit);

  try {
    let where = ' WHERE 1=1';
    const params = [];
    if (status)          { where += ' AND o.status = ?';          params.push(status); }
    if (priority)        { where += ' AND o.priority = ?';        params.push(priority); }
    if (customer_id)     { where += ' AND o.customer_id = ?';     params.push(customer_id); }
    if (approval_status) { where += ' AND o.approval_status = ?'; params.push(approval_status); }

    if (technician_id) {
      where += ` AND EXISTS (SELECT 1 FROM oki_order_technicians ot2 WHERE ot2.order_id = o.id AND ot2.technician_id = ? AND ot2.status = 'ASSIGNED')`;
      params.push(technician_id);
    }

    if (req.user.type === 'technician') {
      where += ` AND EXISTS (SELECT 1 FROM oki_order_technicians ot3 WHERE ot3.order_id = o.id AND ot3.technician_id = ? AND ot3.status = 'ASSIGNED')`;
      params.push(req.user.id);
    }

    const [rows] = await pool.query(
      `SELECT o.id, o.order_no, o.category, o.priority, o.status, o.approval_status,
              o.wilayah, o.tanggal_mulai, o.tanggal_selesai_target,
              c.nama_perusahaan, o.created_at, o.selesai_at,
              (o.biaya_jasa + o.biaya_sparepart + o.biaya_transport) AS total_biaya,
              (SELECT GROUP_CONCAT(t.nama SEPARATOR ', ')
                 FROM oki_order_technicians ot JOIN oki_technicians t ON t.id = ot.technician_id
                 WHERE ot.order_id = o.id AND ot.status = 'ASSIGNED') AS technician_names
       FROM oki_orders o
       JOIN oki_customers c ON c.id = o.customer_id
       ${where}
       ORDER BY o.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset],
    );

    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM oki_orders o ${where}`, params);

    return res.json({
      success: true,
      orders: rows,
      pagination: { page: Number(page), limit: Number(limit), total, total_pages: Math.ceil(total / limit) },
    });
  } catch (e) {
    console.error('[ORDER list]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* GET /api/orders/:id */
router.get('/:id', async (req, res) => {
  try {
    let order = await getOrderWithEligibility(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order tidak ditemukan' });

    if (req.user.type === 'technician') {
      const isInvolved = [...order.technicians_planned, ...order.technicians_accepted, ...order.technicians_assigned, ...order.technicians_rejected]
        .some(t => Number(t.id) === Number(req.user.id));
      if (!isInvolved) return res.status(403).json({ success: false, message: 'Order ini bukan milik Anda' });
      order = redactForTechnician(order);
    }

    const [timeline] = await pool.query(
      `SELECT * FROM oki_order_timeline WHERE order_id = ? ORDER BY created_at ASC`,
      [req.params.id],
    );

    return res.json({ success: true, order, timeline });
  } catch (e) {
    console.error('[ORDER detail]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/orders — HANYA ADMIN
   multipart/form-data: field teks biasa + rincian_biaya & kebutuhan_pra_assign
   sebagai JSON string, files[]/judul[] = lampiran pendukung.
═══════════════════════════════════════════════════ */
router.post('/', requireRole('ADMIN'), handleUploadMultiple('files', 15), async (req, res) => {
  const b = req.body;
  const parseJson = (v, fallback) => { try { return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; } };

  const kode_site = b.kode_site;
  const customer_id = b.customer_id;
  const site_id = b.site_id;
  const rincian_biaya = parseJson(b.rincian_biaya, []);
  const kebutuhan_pra_assign = parseJson(b.kebutuhan_pra_assign, []);
  const judulList = Array.isArray(b.judul) ? b.judul : (b.judul ? [b.judul] : []);

  if (!customer_id) {
    return res.status(400).json({ success: false, message: 'customer_id wajib diisi' });
  }
  if (!site_id) {
    return res.status(400).json({ success: false, message: 'site_id wajib diisi — pilih lokasi dari Master Site, gak bisa input manual' });
  }

  // Titik lokasi SELALU diambil dari Master Site yang terdaftar (server yang
  // nentuin, bukan dari input client) — ini yang mastiin "gak ada isi manual"
  // beneran ditegakkan, bukan cuma disembunyikan di UI doang.
  const [[site]] = await pool.query(`SELECT * FROM oki_customer_sites WHERE id = ?`, [site_id]);
  if (!site) {
    return res.status(404).json({ success: false, message: 'Site tidak ditemukan' });
  }
  if (Number(site.customer_id) !== Number(customer_id)) {
    return res.status(400).json({ success: false, message: 'Site yang dipilih bukan milik customer ini' });
  }
  if (!site.latitude || !site.longitude) {
    return res.status(400).json({ success: false, message: 'Site ini belum punya titik koordinat — lengkapi dulu di Master Site' });
  }

  const wilayah = [site.kota, site.provinsi].filter(Boolean).join(', ') || site.site_name;
  const alamat_detail = site.alamat_detail || site.site_name;

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [result] = await conn.query(
      `INSERT INTO oki_orders
         (order_no, customer_id, site_id, category, priority, description,
          wilayah, alamat_detail, lokasi_lat, lokasi_lng, tanggal_mulai, tanggal_selesai_target,
          biaya_jasa, biaya_sparepart, biaya_transport, created_by)
       VALUES ('TEMP', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        customer_id, site_id, b.category || site.kategori || 'CORRECTIVE', b.priority || 'MEDIUM', b.description || null,
        wilayah, alamat_detail, site.latitude, site.longitude,
        b.tanggal_mulai || null, b.tanggal_selesai_target || null,
        b.biaya_jasa || 0, b.biaya_sparepart || 0, b.biaya_transport || 0, req.user.id,
      ],
    );

    const orderId = result.insertId;
    const orderNo = `ORD-${site.kode_site}-${String(orderId).padStart(3, '0')}`;
    await conn.query(`UPDATE oki_orders SET order_no = ? WHERE id = ?`, [orderNo, orderId]);

    if (Array.isArray(rincian_biaya)) {
      for (const item of rincian_biaya) {
        if (!item || !item.jumlah) continue;
        await conn.query(
          `INSERT INTO oki_order_biaya (order_id, jenis, deskripsi, jumlah, timing_bayar) VALUES (?, ?, ?, ?, ?)`,
          [orderId, item.jenis || 'LAINNYA', item.deskripsi || null, item.jumlah, item.timing_bayar || 'SESUDAH'],
        );
      }
    }

    if (Array.isArray(kebutuhan_pra_assign)) {
      for (const item of kebutuhan_pra_assign) {
        if (!item || !item.nama_item) continue;
        await conn.query(
          `INSERT INTO oki_order_kebutuhan (order_id, nama_item, qty, estimasi_harga, keterangan) VALUES (?, ?, ?, ?, ?)`,
          [orderId, item.nama_item, item.qty || 1, item.estimasi_harga || null, item.keterangan || null],
        );
      }
    }

    if (req.files && req.files.length) {
      await saveFiles(conn, orderId, 'LAMPIRAN', req.files, req.user.id, null, judulList);
    }

    await conn.query(
      `INSERT INTO oki_order_timeline (order_id, event_type, note, actor_type, actor_id) VALUES (?, 'CREATED', ?, 'USER', ?)`,
      [orderId, `Order ${orderNo} dibuat`, req.user.id],
    );

    await conn.commit();
    emitToDashboard('order-created', { orderId, orderNo });
    return res.json({ success: true, orderId, orderNo });
  } catch (e) {
    await conn.rollback();
    console.error('[ORDER create]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    conn.release();
  }
});

/* ═══════════════════════════════════════════════════
   PUT /api/orders/:id — HANYA ADMIN, dan cuma selama order status masih NEW
   (belum di-assign/dikerjakan) biar gak ganggu data finansial yang udah
   berjalan. Edit dasar aja (detail pekerjaan/lokasi/jadwal).
═══════════════════════════════════════════════════ */
router.put('/:id', requireRole('ADMIN'), async (req, res) => {
  const b = req.body;
  try {
    const [rows] = await pool.query(`SELECT status FROM oki_orders WHERE id = ?`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Order tidak ditemukan' });
    if (rows[0].status !== 'NEW') {
      return res.status(409).json({ success: false, message: 'Order yang sudah diproses (bukan status NEW) tidak bisa diedit lagi' });
    }

    const fields = ['category', 'priority', 'description', 'wilayah', 'alamat_detail', 'lokasi_lat', 'lokasi_lng', 'tanggal_mulai', 'tanggal_selesai_target'];
    const sets = fields.filter(f => b[f] !== undefined);
    if (sets.length === 0) return res.status(400).json({ success: false, message: 'Tidak ada field yang diupdate' });

    await pool.query(
      `UPDATE oki_orders SET ${sets.map(f => `${f}=?`).join(', ')} WHERE id = ?`,
      [...sets.map(f => b[f] || null), req.params.id],
    );
    await logTimeline(req.params.id, 'NOTE', 'Detail order diedit admin', 'USER', req.user.id);
    return res.json({ success: true, message: 'Order berhasil diupdate' });
  } catch (e) {
    console.error('[ORDER update]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* POST /api/orders/:id/attachments — HANYA ADMIN */
router.post('/:id/attachments', requireRole('ADMIN'), handleUploadMultiple('files', 15), async (req, res) => {
  if (!req.files || !req.files.length) {
    return res.status(400).json({ success: false, message: 'Tidak ada file yang diupload' });
  }
  const judulList = Array.isArray(req.body.judul) ? req.body.judul : (req.body.judul ? [req.body.judul] : []);
  const conn = await pool.getConnection();
  try {
    const urls = await saveFiles(conn, req.params.id, 'LAMPIRAN', req.files, req.user.id, null, judulList);
    await logTimeline(req.params.id, 'NOTE', `${req.files.length} lampiran ditambahkan`, 'USER', req.user.id);
    return res.json({ success: true, files: urls });
  } catch (e) {
    console.error('[ORDER attachments]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    conn.release();
  }
});

/* POST /api/orders/:id/approve — HANYA ATASAN */
router.post('/:id/approve', requireRole('ATASAN'), async (req, res) => {
  const { note } = req.body;
  try {
    await pool.query(
      `UPDATE oki_orders SET approval_status='APPROVED', approved_by=?, approved_at=NOW(), approval_note=? WHERE id = ?`,
      [req.user.id, note || null, req.params.id],
    );
    await logTimeline(req.params.id, 'APPROVED', note || 'Order disetujui atasan', 'USER', req.user.id);
    emitToDashboard('order-approved', { orderId: Number(req.params.id) });
    return res.json({ success: true, message: 'Order disetujui' });
  } catch (e) {
    console.error('[ORDER approve]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* POST /api/orders/:id/reject — HANYA ATASAN */
router.post('/:id/reject', requireRole('ATASAN'), async (req, res) => {
  const { note } = req.body;
  try {
    await pool.query(
      `UPDATE oki_orders SET approval_status='REJECTED', status='REJECTED', approved_by=?, approved_at=NOW(), approval_note=? WHERE id = ?`,
      [req.user.id, note || null, req.params.id],
    );
    await logTimeline(req.params.id, 'REJECTED', note || 'Order ditolak atasan', 'USER', req.user.id);
    emitToDashboard('order-rejected', { orderId: Number(req.params.id) });
    return res.json({ success: true, message: 'Order ditolak' });
  } catch (e) {
    console.error('[ORDER reject]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/orders/:id/plan-technician — HANYA ADMIN
   "Flagging" / nawarin tugas ke 1 teknisi. Boleh kapan aja. Teknisi bakal
   dapet notifikasi & harus accept/reject dari halaman profile-nya.
   body: { technician_id }
═══════════════════════════════════════════════════ */
router.post('/:id/plan-technician', requireRole('ADMIN'), async (req, res) => {
  const { technician_id } = req.body;
  if (!technician_id) return res.status(400).json({ success: false, message: 'technician_id wajib diisi' });
  try {
    const [tech] = await pool.query(`SELECT id, nama FROM oki_technicians WHERE id = ? AND is_active = 1`, [technician_id]);
    if (tech.length === 0) return res.status(404).json({ success: false, message: 'Teknisi tidak ditemukan/nonaktif' });

    await pool.query(
      `INSERT INTO oki_order_technicians (order_id, technician_id, status, assigned_by, response_note, responded_at)
       VALUES (?, ?, 'PLANNED', ?, NULL, NULL)
       ON DUPLICATE KEY UPDATE status='PLANNED', assigned_by=VALUES(assigned_by), response_note=NULL, responded_at=NULL`,
      [req.params.id, technician_id, req.user.id],
    );
    await logTimeline(req.params.id, 'NOTE', `Tugas ditawarkan ke ${tech[0].nama}`, 'USER', req.user.id);
    emitToDashboard('order-updated', { orderId: Number(req.params.id) });
    emitToTechnician(technician_id, 'new-offer', { orderId: Number(req.params.id) });
    sendPushToTechnician(technician_id, 'Tawaran Tugas Baru', `Order ${req.params.id} menunggu respon kamu`, { orderId: req.params.id, type: 'new-offer' });
    return res.json({ success: true, message: `Tugas ditawarkan ke ${tech[0].nama}, menunggu respon` });
  } catch (e) {
    console.error('[ORDER plan-technician]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* DELETE /api/orders/:id/plan-technician/:technicianId — HANYA ADMIN
   Cuma bisa hapus kalau statusnya PLANNED atau REJECTED (bukan ACCEPTED/ASSIGNED). */
router.delete('/:id/plan-technician/:technicianId', requireRole('ADMIN'), async (req, res) => {
  try {
    const [result] = await pool.query(
      `DELETE FROM oki_order_technicians WHERE order_id = ? AND technician_id = ? AND status IN ('PLANNED','REJECTED')`,
      [req.params.id, req.params.technicianId],
    );
    if (result.affectedRows === 0) {
      return res.status(409).json({ success: false, message: 'Teknisi ini sudah ACCEPTED/ASSIGNED, tidak bisa dibatalkan dari sini' });
    }
    emitToDashboard('order-updated', { orderId: Number(req.params.id) });
    return res.json({ success: true, message: 'Tawaran dibatalkan' });
  } catch (e) {
    console.error('[ORDER unplan-technician]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/orders/:id/respond — HANYA TEKNISI
   Teknisi terima/tolak tawaran tugas yang ditujukan buat dirinya sendiri.
   body: { response: 'ACCEPTED' | 'REJECTED', note? }
═══════════════════════════════════════════════════ */
router.post('/:id/respond', requireTechnician, async (req, res) => {
  const { response, note } = req.body;
  if (!['ACCEPTED', 'REJECTED'].includes(response)) {
    return res.status(400).json({ success: false, message: "response harus 'ACCEPTED' atau 'REJECTED'" });
  }
  try {
    const [result] = await pool.query(
      `UPDATE oki_order_technicians SET status=?, response_note=?, responded_at=NOW()
       WHERE order_id = ? AND technician_id = ? AND status = 'PLANNED'`,
      [response, note || null, req.params.id, req.user.id],
    );
    if (result.affectedRows === 0) {
      return res.status(409).json({ success: false, message: 'Tidak ada tawaran tugas yang menunggu respon Anda di order ini' });
    }

    const [[tech]] = await pool.query(`SELECT nama FROM oki_technicians WHERE id = ?`, [req.user.id]);
    const msg = response === 'ACCEPTED' ? `${tech.nama} menerima tawaran tugas` : `${tech.nama} menolak tawaran tugas`;
    await logTimeline(req.params.id, 'NOTE', msg, 'TECHNICIAN', req.user.id);
    emitToDashboard('order-updated', { orderId: Number(req.params.id) });

    return res.json({ success: true, message: response === 'ACCEPTED' ? 'Tugas diterima' : 'Tugas ditolak' });
  } catch (e) {
    console.error('[ORDER respond]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/orders/:id/pekerjaan — HANYA TEKNISI yang ASSIGNED di order ini
   Upload bukti hasil kerja (foto dsb) — boleh kapan aja selama order
   berstatus ON_THE_WAY/IN_PROGRESS/DONE, boleh berkali-kali (nambah, gak
   nge-replace yang lama).
   multipart/form-data: { files[]: File[] (wajib >=1), keterangan?: string }
═══════════════════════════════════════════════════ */
router.post('/:id/pekerjaan', requireTechnician, handleUploadMultiple('files', 10), async (req, res) => {
  if (!req.files || !req.files.length) {
    return res.status(400).json({ success: false, message: 'Upload minimal 1 foto/file bukti pekerjaan' });
  }
  try {
    const [[relation]] = await pool.query(
      `SELECT status FROM oki_order_technicians WHERE order_id = ? AND technician_id = ?`,
      [req.params.id, req.user.id],
    );
    if (!relation || relation.status !== 'ASSIGNED') {
      return res.status(403).json({ success: false, message: 'Anda belum di-assign final ke order ini' });
    }
    const [[order]] = await pool.query(`SELECT status FROM oki_orders WHERE id = ?`, [req.params.id]);
    if (!['ON_THE_WAY', 'IN_PROGRESS', 'DONE'].includes(order.status)) {
      return res.status(409).json({ success: false, message: 'Order belum berjalan, belum bisa upload bukti pekerjaan' });
    }

    const conn = await pool.getConnection();
    try {
      const judulList = Array.isArray(req.body.keterangan) ? req.body.keterangan : (req.body.keterangan ? [req.body.keterangan] : null);
      const urls = await saveFiles(conn, req.params.id, 'PEKERJAAN', req.files, req.user.id, null, judulList, 'TECHNICIAN');
      const [[tech]] = await conn.query(`SELECT nama FROM oki_technicians WHERE id = ?`, [req.user.id]);
      await logTimeline(req.params.id, 'NOTE', `${tech.nama} upload ${req.files.length} bukti pekerjaan`, 'TECHNICIAN', req.user.id);
      emitToDashboard('order-updated', { orderId: Number(req.params.id) });
      return res.json({ success: true, message: 'Bukti pekerjaan berhasil diupload', files: urls });
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error('[ORDER pekerjaan]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/orders/:id/kebutuhan/:kebutuhanId/dibeli — HANYA FINANCE
   multipart/form-data: { files[]?: File[] (boleh banyak), keterangan?: string }
═══════════════════════════════════════════════════ */
router.post('/:id/kebutuhan/:kebutuhanId/dibeli', requireRole('FINANCE'), handleUploadMultiple('files', 10), async (req, res) => {
  const { keterangan } = req.body;
  if (!req.files || !req.files.length) {
    return res.status(400).json({ success: false, message: 'Upload minimal 1 file bukti pembelian/transfer dulu sebelum menandai selesai' });
  }
  const conn = await pool.getConnection();
  try {
    await conn.query(
      `UPDATE oki_order_kebutuhan SET status='DIBELI', dibeli_by=?, dibeli_at=NOW(), keterangan=COALESCE(?, keterangan)
       WHERE id = ? AND order_id = ?`,
      [req.user.id, keterangan || null, req.params.kebutuhanId, req.params.id],
    );
    let urls = [];
    if (req.files && req.files.length) {
      urls = await saveFiles(conn, req.params.id, 'KEBUTUHAN', req.files, req.user.id, Number(req.params.kebutuhanId));
      await conn.query(`UPDATE oki_order_kebutuhan SET bukti_url = ? WHERE id = ?`, [urls[0], req.params.kebutuhanId]);
    }
    await logTimeline(req.params.id, 'NOTE', 'Finance menandai 1 kebutuhan pra-assign sudah dibeli', 'USER', req.user.id);
    emitToDashboard('order-updated', { orderId: Number(req.params.id) });
    return res.json({ success: true, message: 'Kebutuhan ditandai selesai dibeli', files: urls });
  } catch (e) {
    console.error('[ORDER kebutuhan-dibeli]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  } finally {
    conn.release();
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/orders/:id/biaya/:biayaId/bayar — HANYA FINANCE
   Tandai 1 baris rincian biaya (jasa/transport/material/lainnya) selesai
   ditransfer, sekalian upload bukti (boleh banyak file).
   Aturan:
     - timing SEBELUM -> boleh TF begitu atasan udah APPROVE
     - timing SESUDAH -> baru boleh TF setelah atasan APPROVE **dan**
       order.status sudah DONE (atau CLOSED)
   multipart/form-data: { files[]?: File[] }
═══════════════════════════════════════════════════ */
router.post('/:id/biaya/:biayaId/bayar', requireRole('FINANCE'), handleUploadMultiple('files', 10), async (req, res) => {
  if (!req.files || !req.files.length) {
    return res.status(400).json({ success: false, message: 'Upload minimal 1 file bukti transfer dulu sebelum menandai selesai' });
  }
  try {
    const [[order]] = await pool.query(`SELECT approval_status, status FROM oki_orders WHERE id = ?`, [req.params.id]);
    if (!order) return res.status(404).json({ success: false, message: 'Order tidak ditemukan' });

    const [[biaya]] = await pool.query(
      `SELECT * FROM oki_order_biaya WHERE id = ? AND order_id = ?`, [req.params.biayaId, req.params.id],
    );
    if (!biaya) return res.status(404).json({ success: false, message: 'Item biaya tidak ditemukan' });
    if (biaya.status === 'DONE') return res.status(409).json({ success: false, message: 'Item biaya ini sudah ditransfer' });

    if (order.approval_status !== 'APPROVED') {
      return res.status(409).json({ success: false, message: 'Menunggu approval atasan dulu sebelum bisa transfer' });
    }
    if (biaya.timing_bayar === 'SESUDAH' && !['DONE', 'CLOSED'].includes(order.status)) {
      return res.status(409).json({ success: false, message: 'Item biaya "Sesudah" baru bisa ditransfer setelah pekerjaan selesai (DONE)' });
    }

    const conn = await pool.getConnection();
    try {
      let urls = [];
      if (req.files && req.files.length) {
        urls = await saveFiles(conn, req.params.id, 'BIAYA', req.files, req.user.id, Number(req.params.biayaId));
      }
      await conn.query(`UPDATE oki_order_biaya SET status='DONE', paid_by=?, paid_at=NOW() WHERE id = ?`, [req.user.id, req.params.biayaId]);
      await logTimeline(req.params.id, 'NOTE', `Finance transfer biaya ${biaya.jenis} (${biaya.deskripsi || '-'}) selesai`, 'USER', req.user.id);
      emitToDashboard('order-updated', { orderId: Number(req.params.id) });
      return res.json({ success: true, message: 'Biaya ditandai selesai ditransfer', files: urls });
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error('[ORDER biaya-bayar]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/orders/:id/assign — HANYA ADMIN
   "Konfirmasi & Assign" FINAL. Mempromosikan teknisi yang sudah ACCEPTED
   jadi ASSIGNED, setelah semua syarat lolos.
   body: { technician_ids?: number[] } (opsional, default pakai yg ACCEPTED)
═══════════════════════════════════════════════════ */
router.post('/:id/assign', requireRole('ADMIN'), async (req, res) => {
  let { technician_ids } = req.body;
  try {
    const [rows] = await pool.query(`SELECT * FROM oki_orders WHERE id = ?`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Order tidak ditemukan' });

    const [existing] = await pool.query(
      `SELECT technician_id, status FROM oki_order_technicians WHERE order_id = ?`, [req.params.id],
    );
    const acceptedCount = existing.filter(t => t.status === 'ACCEPTED').length;
    const assignedCount = existing.filter(t => t.status === 'ASSIGNED').length;
    const pendingKebutuhan = await countPendingKebutuhan(req.params.id);
    const pendingBiayaSebelum = await countPendingBiayaSebelum(req.params.id);

    const eligibility = getAssignEligibility(rows[0], pendingKebutuhan, pendingBiayaSebelum, acceptedCount, assignedCount);
    if (!eligibility.eligible) {
      return res.status(409).json({ success: false, message: eligibility.reason, blockedAt: eligibility.blockedAt });
    }

    if (!Array.isArray(technician_ids) || technician_ids.length === 0) {
      technician_ids = existing.filter(t => t.status === 'ACCEPTED').map(t => t.technician_id);
    }
    if (technician_ids.length === 0) {
      return res.status(400).json({ success: false, message: 'Belum ada teknisi yang menerima tawaran' });
    }

    const [techs] = await pool.query(`SELECT id, nama FROM oki_technicians WHERE id IN (?) AND is_active = 1`, [technician_ids]);
    if (techs.length !== technician_ids.length) {
      return res.status(404).json({ success: false, message: 'Ada teknisi yang tidak ditemukan/nonaktif' });
    }

    for (const techId of technician_ids) {
      await pool.query(
        `UPDATE oki_order_technicians SET status='ASSIGNED', assigned_by=?, assigned_at=NOW() WHERE order_id=? AND technician_id=?`,
        [req.user.id, req.params.id, techId],
      );
      await pool.query(`UPDATE oki_technicians SET status='ON_DUTY' WHERE id = ?`, [techId]);
    }

    await pool.query(`UPDATE oki_orders SET assigned_by=?, assigned_at=NOW(), status='ASSIGNED' WHERE id=?`, [req.user.id, req.params.id]);

    const names = techs.map(t => t.nama).join(', ');
    await logTimeline(req.params.id, 'ASSIGNED', `Dikonfirmasi & ditugaskan ke ${names}`, 'USER', req.user.id);
    emitToDashboard('order-assigned', { orderId: Number(req.params.id), technicianIds: technician_ids });
    technician_ids.forEach(techId => emitToTechnician(techId, 'assignment-confirmed', { orderId: Number(req.params.id) }));
    technician_ids.forEach(techId => sendPushToTechnician(techId, 'Tugas Dikonfirmasi', `Order ${req.params.id} sudah di-assign final, siap dikerjakan`, { orderId: req.params.id, type: 'assignment-confirmed' }));
    
    return res.json({ success: true, message: `Order berhasil di-assign ke ${names}` });
  } catch (e) {
    console.error('[ORDER assign]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/orders/:id/status
   Progres pekerjaan: ON_THE_WAY / IN_PROGRESS / DONE -> HANYA teknisi yang
   ASSIGNED di order ini (Admin TIDAK boleh lagi ubah status pekerjaan).
   CANCELLED -> boleh Admin ATAU teknisi yang ASSIGNED.
═══════════════════════════════════════════════════ */
router.post('/:id/status', async (req, res) => {
  const { status, note } = req.body;
  const allowed = ['ON_THE_WAY', 'IN_PROGRESS', 'DONE', 'CANCELLED'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ success: false, message: `status harus salah satu dari: ${allowed.join(', ')}` });
  }

  try {
    const [rows] = await pool.query(`SELECT * FROM oki_orders WHERE id = ?`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Order tidak ditemukan' });

    let isOwnerTechnician = false;
    if (req.user.type === 'technician') {
      const [membership] = await pool.query(
        `SELECT 1 FROM oki_order_technicians WHERE order_id = ? AND technician_id = ? AND status = 'ASSIGNED'`,
        [req.params.id, req.user.id],
      );
      isOwnerTechnician = membership.length > 0;
    }
    const isAdmin = req.user.type === 'staff' && req.user.role === 'ADMIN';

    const isProgressStatus = ['ON_THE_WAY', 'IN_PROGRESS', 'DONE'].includes(status);
    if (isProgressStatus && !isOwnerTechnician) {
      return res.status(403).json({ success: false, message: 'Update progres pekerjaan cuma boleh dilakukan teknisi yang ditugaskan' });
    }
    if (status === 'CANCELLED' && !isOwnerTechnician && !isAdmin) {
      return res.status(403).json({ success: false, message: 'Tidak berhak membatalkan order ini' });
    }

    if (rows[0].status === 'ASSIGNED' && status !== 'ON_THE_WAY' && status !== 'CANCELLED') {
      return res.status(409).json({ success: false, message: 'Order harus ON_THE_WAY dulu sebelum IN_PROGRESS' });
    }

    const isDone = status === 'DONE';
    await pool.query(
      `UPDATE oki_orders SET status = ?${isDone ? ', selesai_at = NOW()' : ''} WHERE id = ?`,
      [status, req.params.id],
    );

    if (isDone || status === 'CANCELLED') {
      const [assignedTechs] = await pool.query(
        `SELECT technician_id FROM oki_order_technicians WHERE order_id = ? AND status = 'ASSIGNED'`,
        [req.params.id],
      );
      for (const t of assignedTechs) {
        await pool.query(`UPDATE oki_technicians SET status='READY' WHERE id = ?`, [t.technician_id]);
      }
    }

    const actorType = req.user.type === 'technician' ? 'TECHNICIAN' : 'USER';
    await logTimeline(req.params.id, status, note || null, actorType, req.user.id);
    emitToDashboard('order-status-updated', { orderId: Number(req.params.id), status });

    return res.json({ success: true, message: `Status order diubah ke ${status}` });
  } catch (e) {
    console.error('[ORDER status]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/orders/:id/close — HANYA ADMIN
   Tutup tiket FINAL, setelah admin cek semua tahap & bukti udah lengkap.
   Cuma bisa kalau order.status = DONE dan SEMUA rincian biaya sudah DONE.
═══════════════════════════════════════════════════ */
router.post('/:id/close', requireRole('ADMIN'), async (req, res) => {
  try {
    const [[order]] = await pool.query(`SELECT status FROM oki_orders WHERE id = ?`, [req.params.id]);
    if (!order) return res.status(404).json({ success: false, message: 'Order tidak ditemukan' });
    if (order.status !== 'DONE') {
      return res.status(409).json({ success: false, message: 'Order harus berstatus DONE (pekerjaan selesai) dulu sebelum bisa ditutup' });
    }
    const [[{ pendingBiaya }]] = await pool.query(
      `SELECT COUNT(*) AS pendingBiaya FROM oki_order_biaya WHERE order_id = ? AND status = 'PENDING'`, [req.params.id],
    );
    if (pendingBiaya > 0) {
      return res.status(409).json({ success: false, message: `Masih ada ${pendingBiaya} biaya yang belum ditransfer Finance` });
    }

    await pool.query(`UPDATE oki_orders SET status='CLOSED' WHERE id = ?`, [req.params.id]);
    await logTimeline(req.params.id, 'NOTE', 'Tiket ditutup admin (semua tahap & bukti sudah diverifikasi)', 'USER', req.user.id);
    emitToDashboard('order-status-updated', { orderId: Number(req.params.id), status: 'CLOSED' });
    return res.json({ success: true, message: 'Tiket berhasil ditutup' });
  } catch (e) {
    console.error('[ORDER close]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;