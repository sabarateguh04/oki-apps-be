const express = require('express');
const pool = require('../db');
const { getAssignEligibility } = require('../helpers/assignEligibility');
const { emitToDashboard, emitToTechnician } = require('../socket');

const router = express.Router();

/* Helper: tulis satu baris ke order_timeline (log aktivitas) */
async function logTimeline(orderId, eventType, note, actorType = 'SYSTEM', actorId = null) {
  await pool.query(
    `INSERT INTO oki_order_timeline (order_id, event_type, note, actor_type, actor_id) VALUES (?, ?, ?, ?, ?)`,
    [orderId, eventType, note || null, actorType, actorId],
  );
}

/* Helper: ambil 1 order + hitung assign eligibility-nya */
async function getOrderWithEligibility(orderId) {
  const [rows] = await pool.query(
    `SELECT o.*, c.nama_perusahaan, c.pic_nama, c.pic_hp, c.alamat AS customer_alamat,
            t.nama AS technician_nama, t.no_hp AS technician_hp, t.email AS technician_email
     FROM oki_orders o
     JOIN oki_customers c ON c.id = o.customer_id
     LEFT JOIN oki_technicians t ON t.id = o.technician_id
     WHERE o.id = ?`,
    [orderId],
  );
  if (rows.length === 0) return null;
  const order = rows[0];
  return { ...order, assign_eligibility: getAssignEligibility(order) };
}

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
    if (technician_id)   { where += ' AND o.technician_id = ?';   params.push(technician_id); }

    const [rows] = await pool.query(
      `SELECT o.id, o.order_no, o.category, o.priority, o.status, o.approval_status,
              o.has_pre_bayar, o.pre_bayar_status, o.payment_timing, o.jasa_teknisi_transfer_status,
              o.technician_id, t.nama AS technician_nama,
              c.nama_perusahaan, o.created_at, o.selesai_at,
              (o.biaya_jasa + o.biaya_sparepart) AS total_biaya
       FROM oki_orders o
       JOIN oki_customers c ON c.id = o.customer_id
       LEFT JOIN oki_technicians t ON t.id = o.technician_id
       ${where}
       ORDER BY o.created_at DESC
       LIMIT ? OFFSET ?`,
      [...params, Number(limit), offset],
    );

    const [[{ total }]] = await pool.query(
      `SELECT COUNT(*) AS total FROM oki_orders o ${where}`,
      params,
    );

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

/* ═══════════════════════════════════════════════════
   GET /api/orders/:id
   Termasuk `assign_eligibility` — frontend TINGGAL PAKAI ini buat
   nentuin tombol Assign muncul apa nggak + pesan block-nya, gak perlu
   ngulang logic kondisinya lagi di sisi client.
═══════════════════════════════════════════════════ */
router.get('/:id', async (req, res) => {
  try {
    const order = await getOrderWithEligibility(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order tidak ditemukan' });

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
   POST /api/orders
   Buat order baru. Status awal selalu NEW + approval_status PENDING —
   gak ada jalur skip approval, semua order wajib direview atasan dulu.
═══════════════════════════════════════════════════ */
router.post('/', async (req, res) => {
  const {
    customer_id, category, priority, description,
    has_pre_bayar, pre_bayar_amount, payment_timing,
    biaya_jasa, biaya_sparepart, created_by,
  } = req.body;

  if (!customer_id || !created_by) {
    return res.status(400).json({ success: false, message: 'customer_id & created_by wajib diisi' });
  }

  try {
    const [result] = await pool.query(
      `INSERT INTO oki_orders
         (order_no, customer_id, category, priority, description,
          has_pre_bayar, pre_bayar_amount, payment_timing,
          biaya_jasa, biaya_sparepart, created_by)
       VALUES ('TEMP', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        customer_id, category || 'CORRECTIVE', priority || 'MEDIUM', description || null,
        has_pre_bayar ? 1 : 0, pre_bayar_amount || null, payment_timing || 'SESUDAH',
        biaya_jasa || 0, biaya_sparepart || 0, created_by,
      ],
    );

    const orderNo = `ORD-${String(result.insertId).padStart(5, '0')}`;
    await pool.query(`UPDATE oki_orders SET order_no = ? WHERE id = ?`, [orderNo, result.insertId]);
    await logTimeline(result.insertId, 'CREATED', `Order ${orderNo} dibuat`, 'USER', created_by);

    emitToDashboard('order-created', { orderId: result.insertId, orderNo });
    return res.json({ success: true, orderId: result.insertId, orderNo });
  } catch (e) {
    console.error('[ORDER create]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/orders/:id/approve
   body: { approved_by, note? }
═══════════════════════════════════════════════════ */
router.post('/:id/approve', async (req, res) => {
  const { approved_by, note } = req.body;
  if (!approved_by) return res.status(400).json({ success: false, message: 'approved_by wajib diisi' });

  try {
    await pool.query(
      `UPDATE oki_orders SET approval_status='APPROVED', approved_by=?, approved_at=NOW(), approval_note=?
       WHERE id = ?`,
      [approved_by, note || null, req.params.id],
    );
    await logTimeline(req.params.id, 'APPROVED', note || 'Order disetujui atasan', 'USER', approved_by);
    emitToDashboard('order-approved', { orderId: Number(req.params.id) });
    return res.json({ success: true, message: 'Order disetujui' });
  } catch (e) {
    console.error('[ORDER approve]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/orders/:id/reject
   body: { rejected_by, note? }
═══════════════════════════════════════════════════ */
router.post('/:id/reject', async (req, res) => {
  const { rejected_by, note } = req.body;
  if (!rejected_by) return res.status(400).json({ success: false, message: 'rejected_by wajib diisi' });

  try {
    await pool.query(
      `UPDATE oki_orders SET approval_status='REJECTED', status='REJECTED', approved_by=?, approved_at=NOW(), approval_note=?
       WHERE id = ?`,
      [rejected_by, note || null, req.params.id],
    );
    await logTimeline(req.params.id, 'REJECTED', note || 'Order ditolak atasan', 'USER', rejected_by);
    emitToDashboard('order-rejected', { orderId: Number(req.params.id) });
    return res.json({ success: true, message: 'Order ditolak' });
  } catch (e) {
    console.error('[ORDER reject]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/orders/:id/pre-bayar-done
   Ditandai selesai oleh Finance. body: { marked_by }
═══════════════════════════════════════════════════ */
router.post('/:id/pre-bayar-done', async (req, res) => {
  const { marked_by } = req.body;
  try {
    await pool.query(
      `UPDATE oki_orders SET pre_bayar_status='DONE', pre_bayar_paid_at=NOW() WHERE id = ?`,
      [req.params.id],
    );
    await logTimeline(req.params.id, 'PRE_BAYAR_DONE', 'Pre-bayar material/equipment selesai diproses Finance', 'USER', marked_by);
    emitToDashboard('order-updated', { orderId: Number(req.params.id) });
    return res.json({ success: true, message: 'Pre-bayar ditandai selesai' });
  } catch (e) {
    console.error('[ORDER pre-bayar-done]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/orders/:id/jasa-teknisi-done
   Transfer jasa teknisi ditandai selesai oleh Finance. body: { marked_by }
═══════════════════════════════════════════════════ */
router.post('/:id/jasa-teknisi-done', async (req, res) => {
  const { marked_by } = req.body;
  try {
    await pool.query(
      `UPDATE oki_orders SET jasa_teknisi_transfer_status='DONE', jasa_teknisi_paid_at=NOW() WHERE id = ?`,
      [req.params.id],
    );
    await logTimeline(req.params.id, 'JASA_TF_DONE', 'Transfer jasa teknisi selesai diproses Finance', 'USER', marked_by);
    emitToDashboard('order-updated', { orderId: Number(req.params.id) });
    return res.json({ success: true, message: 'Transfer jasa teknisi ditandai selesai' });
  } catch (e) {
    console.error('[ORDER jasa-teknisi-done]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/orders/:id/assign
   INI YANG NGE-ENFORCE "ASSIGN BUTTON VISIBILITY" DI SISI SERVER.
   Frontend boleh aja nyembunyiin tombolnya berdasarkan `assign_eligibility`
   dari GET /:id, tapi endpoint ini TETAP ngecek ulang dari nol — supaya
   gak bisa di-bypass dengan manggil API langsung.
   body: { technician_id, assigned_by }
═══════════════════════════════════════════════════ */
router.post('/:id/assign', async (req, res) => {
  const { technician_id, assigned_by } = req.body;
  if (!technician_id || !assigned_by) {
    return res.status(400).json({ success: false, message: 'technician_id & assigned_by wajib diisi' });
  }

  try {
    const [rows] = await pool.query(`SELECT * FROM oki_orders WHERE id = ?`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Order tidak ditemukan' });

    const eligibility = getAssignEligibility(rows[0]);
    if (!eligibility.eligible) {
      return res.status(409).json({ success: false, message: eligibility.reason, blockedAt: eligibility.blockedAt });
    }

    const [tech] = await pool.query(`SELECT id, nama FROM oki_technicians WHERE id = ? AND is_active = 1`, [technician_id]);
    if (tech.length === 0) return res.status(404).json({ success: false, message: 'Teknisi tidak ditemukan/nonaktif' });

    await pool.query(
      `UPDATE oki_orders SET technician_id=?, assigned_by=?, assigned_at=NOW(), status='ASSIGNED' WHERE id=?`,
      [technician_id, assigned_by, req.params.id],
    );
    await pool.query(`UPDATE oki_technicians SET status='ON_DUTY' WHERE id = ?`, [technician_id]);
    await logTimeline(req.params.id, 'ASSIGNED', `Ditugaskan ke ${tech[0].nama}`, 'USER', assigned_by);

    emitToDashboard('order-assigned', { orderId: Number(req.params.id), technicianId: technician_id });
    emitToTechnician(technician_id, 'new-assignment', { orderId: Number(req.params.id) });

    return res.json({ success: true, message: `Order berhasil di-assign ke ${tech[0].nama}` });
  } catch (e) {
    console.error('[ORDER assign]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/orders/:id/status
   Progres pekerjaan oleh teknisi: ON_THE_WAY → IN_PROGRESS → DONE
   (atau CANCELLED kapan saja sebelum DONE).
   body: { status, actor_type: 'TECHNICIAN'|'USER', actor_id, note? }
═══════════════════════════════════════════════════ */
router.post('/:id/status', async (req, res) => {
  const { status, actor_type = 'SYSTEM', actor_id = null, note } = req.body;
  const allowed = ['ON_THE_WAY', 'IN_PROGRESS', 'DONE', 'CANCELLED'];
  if (!allowed.includes(status)) {
    return res.status(400).json({ success: false, message: `status harus salah satu dari: ${allowed.join(', ')}` });
  }

  try {
    const [rows] = await pool.query(`SELECT * FROM oki_orders WHERE id = ?`, [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ success: false, message: 'Order tidak ditemukan' });
    if (rows[0].status === 'ASSIGNED' && status !== 'ON_THE_WAY' && status !== 'CANCELLED') {
      return res.status(409).json({ success: false, message: 'Order harus ON_THE_WAY dulu sebelum IN_PROGRESS' });
    }

    const isDone = status === 'DONE';
    await pool.query(
      `UPDATE oki_orders SET status = ?${isDone ? ', selesai_at = NOW()' : ''} WHERE id = ?`,
      [status, req.params.id],
    );

    // Teknisi selesai satu order → balik lagi jadi READY (siap ambil order lain)
    if ((isDone || status === 'CANCELLED') && rows[0].technician_id) {
      await pool.query(`UPDATE oki_technicians SET status='READY' WHERE id = ?`, [rows[0].technician_id]);
    }

    await logTimeline(req.params.id, status, note || null, actor_type, actor_id);
    emitToDashboard('order-status-updated', { orderId: Number(req.params.id), status });

    return res.json({ success: true, message: `Status order diubah ke ${status}` });
  } catch (e) {
    console.error('[ORDER status]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;