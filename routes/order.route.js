const express = require('express');
const pool = require('../db');
const { getAssignEligibility } = require('../helpers/assignEligibility');
const { emitToDashboard, emitToTechnician, emitToDashboardRoles } = require('../socket');
const { requireAuth, requireRole, requireTechnician } = require('../middleware/auth');
const { handleUploadMultiple, publicUrlFor } = require('../middleware/upload');
const { sendPushToTechnician } = require('../push');

const router = express.Router();
router.use(requireAuth);

/* Siapa yang perlu tau tiap jenis event -- "siapa yang perlu ACT
   selanjutnya", bukan siapa yang baru aja ngelakuin aksinya (pelaku gak
   perlu dinotifikasi soal aksinya sendiri). Dipakai sebagai fallback di
   logTimeline() kalau targetRoles gak di-override manual pas manggil.
   Array kosong [] artinya sengaja gak ada yang dinotifikasi (biar gak
   spam untuk event yang gak butuh aksi lanjutan dari staff lain, misal
   upload bukti kerja / isi 1 item checklist BA). */
const NOTIF_ROLE_MAP = {
  CREATED: ['ATASAN'],           // order baru -> nunggu approval atasan
  APPROVED: ['ADMIN', 'FINANCE'], // admin lanjut assign, finance mulai bisa TF/beli
  REJECTED: ['ADMIN'],            // creator perlu tau order ditolak
  ASSIGNED: [],                   // teknisi udah dinotif jalur terpisah, staff lain gak urgent
  ON_THE_WAY: ['ADMIN'],
  IN_PROGRESS: ['ADMIN'],
  DONE: ['ADMIN', 'FINANCE'], // admin bisa close, finance bisa TF biaya SESUDAH
  CANCELLED: ['ADMIN', 'ATASAN'],
  NOTE: [], // default skip -- override manual per pemanggilan kalau perlu
};

/* BARU: dipakai gantiin emitToDashboard('order-updated', ...) polos --
   sekarang SEKALIAN nge-ping teknisi yang lagi ASSIGNED di order ini
   lewat room pribadi mereka. Ini yang bikin halaman detail tugas
   teknisi (web/app) auto-refresh sendiri kalau lagi kebuka, tanpa perlu
   keluar-masuk halaman atau nunggu notif di-klik dulu. */
async function notifyOrderChanged(orderId) {
  emitToDashboard('order-updated', { orderId: Number(orderId) });
  try {
    const [techs] = await pool.query(
      `SELECT technician_id FROM oki_order_technicians WHERE order_id = ? AND status = 'ASSIGNED'`,
      [orderId],
    );
    techs.forEach(t => emitToTechnician(t.technician_id, 'order-updated', { orderId: Number(orderId) }));
  } catch (e) {
    console.error('[NOTIFY order-changed]', e.message);
  }
}

/* Helper: tulis satu baris ke order_timeline (log aktivitas) SEKALIGUS
   broadcast notifikasi real-time ke role yang RELEVAN (bukan broadcast
   ke semua staff). Ini SATU-SATUNYA titik notifikasi disebar, karena
   logTimeline() ini udah dipanggil di hampir semua aksi order.
   targetRoles: array role string (override manual). Kalau gak dikasih
   (undefined/null), fallback ke NOTIF_ROLE_MAP[eventType] -- atau ['ADMIN']
   kalau eventType-nya gak dikenal di map itu.
   Riwayat notifikasi juga dibaca LANGSUNG dari oki_order_timeline (lihat
   GET /api/dashboard/notifications) -- gak ada tabel notifikasi terpisah. */
async function logTimeline(orderId, eventType, note, actorType = 'SYSTEM', actorId = null, targetRoles = null) {
  const roles = targetRoles !== null ? targetRoles : (NOTIF_ROLE_MAP[eventType] ?? ['ADMIN']);

  await pool.query(
    `INSERT INTO oki_order_timeline (order_id, event_type, note, actor_type, actor_id, notif_roles) VALUES (?, ?, ?, ?, ?, ?)`,
    [orderId, eventType, note || null, actorType, actorId, roles.length ? roles.join(',') : null],
  );

  if (!roles.length) return; // sengaja gak ada yang perlu dinotif buat event ini

  try {
    const [[ctx]] = await pool.query(
      `SELECT o.order_no, c.nama_perusahaan FROM oki_orders o JOIN oki_customers c ON c.id = o.customer_id WHERE o.id = ?`,
      [orderId],
    );
    emitToDashboardRoles(roles, 'notification', {
      orderId: Number(orderId),
      orderNo: ctx?.order_no || null,
      customerName: ctx?.nama_perusahaan || null,
      eventType,
      note: note || null,
      actorType,
      createdAt: new Date().toISOString(),
    });
  } catch (e) {
    // Gagal broadcast notifikasi TIDAK boleh bikin aksi utamanya gagal --
    // timeline-nya udah tersimpan di atas, ini cuma "bonus" real-time push.
    console.error('[NOTIF emit]', e.message);
  }
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

/* BARU: hitung berapa item checklist BA yang masih PENDING di 1 order.
   Kalau customer order ini gak punya BA, otomatis 0 baris (query aman,
   gak perlu cek terpisah "punya BA atau nggak"). */
async function countPendingBaChecklist(orderId) {
  const [[row]] = await pool.query(
    `SELECT COUNT(*) AS n FROM oki_order_ba_checklist WHERE order_id = ? AND status = 'PENDING'`,
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
    const [result] = await conn.query(
      `INSERT INTO oki_order_files (order_id, kategori, ref_id, judul, file_url, uploaded_by, uploaded_by_technician_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        orderId, kategori, refId, judul, url,
        uploaderType === 'USER' ? uploadedBy : null,
        uploaderType === 'TECHNICIAN' ? uploadedBy : null,
      ],
    );
    urls.push({ id: result.insertId, url });
  }
  return urls;
}

/* Snapshot BA sekarang dari SITE (bukan customer lagi) -- karena jumlah
   & jenis perangkat tiap site beda-beda meski customer-nya sama. Kalau
   site gak punya BA, fungsi ini gak ngapa-ngapain (order jalan bebas
   seperti biasa, gak ada checklist). */
async function snapshotBaChecklist(conn, orderId, siteId) {
  const [[ba]] = await conn.query(`SELECT id FROM oki_site_ba WHERE id_site = ?`, [siteId]);
  if (!ba) return; // site belum punya BA -- normal, skip aja

  const [templates] = await conn.query(
    `SELECT * FROM oki_site_ba_template WHERE id_site_ba = ? ORDER BY urutan ASC, id ASC`,
    [ba.id],
  );
  for (const t of templates) {
    // BARU: kalau template item ini punya "unit default" (perangkat yang
    // emang udah terpasang di site ini), otomatis dibawa jadi
    // expected_perangkat_id di order baru -- jadi buat tiket MAINTENANCE/
    // GANGGUAN biasa ke site yang sama, admin GAK PERLU assign ulang
    // manual tiap kali. Teknisi tinggal konfirmasi SN di lapangan seperti
    // biasa, otomatis kecek cocok/nggak sama unit yang seharusnya ada.
    await conn.query(
      `INSERT INTO oki_order_ba_checklist
         (order_id, template_id, category, template_name, template_type, note_ba, urutan, expected_perangkat_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [orderId, t.id, t.category, t.template_name, t.template_type, t.note_ba, t.urutan, t.default_perangkat_id || null],
    );
  }
}

/* Helper: ambil 1 order + hitung assign eligibility-nya + teknisi + kebutuhan + biaya + file + checklist BA */
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
  // BARU: checklist BA -- JOIN ke oki_order_files buat dapetin file_url
  // item yang tipenya 'file' (kalau sudah diisi), DAN JOIN ke oki_perangkat
  // buat nampilin info unit yang di-pre-assign admin (nama + SN yang
  // SEHARUSNYA dipasang, buat dibandingin sama input teknisi di lapangan).
  const [baChecklist] = await pool.query(
    `SELECT bc.*, f.file_url,
            ep.nama_perangkat AS expected_perangkat_name,
            ep.serial_number AS expected_serial_number
     FROM oki_order_ba_checklist bc
     LEFT JOIN oki_order_files f ON f.id = bc.file_id
     LEFT JOIN oki_perangkat ep ON ep.id = bc.expected_perangkat_id
     WHERE bc.order_id = ?
     ORDER BY bc.urutan ASC, bc.id ASC`,
    [orderId],
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
    ba_checklist: baChecklist, // [] kalau customer gak punya BA -- FE tinggal cek .length
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
    if (status) { where += ' AND o.status = ?'; params.push(status); }
    if (priority) { where += ' AND o.priority = ?'; params.push(priority); }
    if (customer_id) { where += ' AND o.customer_id = ?'; params.push(customer_id); }
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

    // BARU: kalau customer ini punya master BA, salin template-nya jadi
    // checklist buat order ini. Kalau gak punya, gak ngapa-ngapain.
    await snapshotBaChecklist(conn, orderId, site_id);

    await conn.query(
      `INSERT INTO oki_order_timeline (order_id, event_type, note, actor_type, actor_id, notif_roles) VALUES (?, 'CREATED', ?, 'USER', ?, ?)`,
      [orderId, `Order ${orderNo} dibuat`, req.user.id, NOTIF_ROLE_MAP.CREATED.join(',')],
    );

    await conn.commit();
    emitToDashboard('order-created', { orderId, orderNo });
    const [[custRow]] = await pool.query(`SELECT nama_perusahaan FROM oki_customers WHERE id = ?`, [customer_id]);
    emitToDashboardRoles(NOTIF_ROLE_MAP.CREATED, 'notification', {
      orderId,
      orderNo,
      customerName: custRow?.nama_perusahaan || null,
      eventType: 'CREATED',
      note: `Order ${orderNo} dibuat`,
      actorType: 'USER',
      createdAt: new Date().toISOString(),
    });
    emitToDashboard('notification', {
      orderId,
      orderNo,
      customerName: null,
      eventType: 'CREATED',
      note: `Order ${orderNo} dibuat`,
      actorType: 'USER',
      createdAt: new Date().toISOString(),
    });
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
    await notifyOrderChanged(req.params.id);
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
    await notifyOrderChanged(req.params.id);
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
    await logTimeline(req.params.id, 'NOTE', msg, 'TECHNICIAN', req.user.id, ['ADMIN']);
    await notifyOrderChanged(req.params.id);

    return res.json({ success: true, message: response === 'ACCEPTED' ? 'Tugas diterima' : 'Tugas ditolak' });
  } catch (e) {
    console.error('[ORDER respond]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/orders/:id/pekerjaan — HANYA TEKNISI yang ASSIGNED di order ini
   Upload bukti hasil kerja BEBAS (foto dsb) — dipakai buat customer yang
   TIDAK punya master BA (lihat ba_checklist di GET /:id -- kalau kosong,
   berarti order ini gak ada template, upload bebas seperti ini tetap jalan
   apa adanya seperti sebelumnya).
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
      const saved = await saveFiles(conn, req.params.id, 'PEKERJAAN', req.files, req.user.id, null, judulList, 'TECHNICIAN');
      const [[tech]] = await conn.query(`SELECT nama FROM oki_technicians WHERE id = ?`, [req.user.id]);
      await logTimeline(req.params.id, 'NOTE', `${tech.nama} upload ${req.files.length} bukti pekerjaan`, 'TECHNICIAN', req.user.id);
      await notifyOrderChanged(req.params.id);
      return res.json({ success: true, message: 'Bukti pekerjaan berhasil diupload', files: saved.map(s => s.url) });
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error('[ORDER pekerjaan]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   BARU: POST /api/orders/:id/ba-checklist/:checklistId — HANYA TEKNISI
   yang ASSIGNED di order ini. Isi SATU item checklist BA:
     - kalau item.template_type === 'text' -> body: { text_value }
     - kalau item.template_type === 'file'  -> multipart/form-data: { file: File (1 file) }
   Boleh diisi ulang (replace) selama order belum DONE/CLOSED.
═══════════════════════════════════════════════════ */
router.post('/:id/ba-checklist/:checklistId', requireTechnician, handleUploadMultiple('file', 1), async (req, res) => {
  try {
    const [[relation]] = await pool.query(
      `SELECT status FROM oki_order_technicians WHERE order_id = ? AND technician_id = ?`,
      [req.params.id, req.user.id],
    );
    if (!relation || relation.status !== 'ASSIGNED') {
      return res.status(403).json({ success: false, message: 'Anda belum di-assign final ke order ini' });
    }
    const [[order]] = await pool.query(`SELECT status FROM oki_orders WHERE id = ?`, [req.params.id]);
    // Boleh diisi/diedit selama ON_THE_WAY / IN_PROGRESS / DONE -- sama
    // kayak endpoint bukti tambahan, baru berhenti bisa diisi setelah
    // admin CLOSE tiketnya (misal teknisi baru sadar ada SN salah ketik
    // setelah declare order selesai, masih bisa dibetulkan sebelum ditutup).
    if (!['ON_THE_WAY', 'IN_PROGRESS', 'DONE'].includes(order.status)) {
      return res.status(409).json({ success: false, message: 'Checklist BA cuma bisa diisi selama order masih berjalan (belum ditutup admin)' });
    }

    const [[item]] = await pool.query(
      `SELECT * FROM oki_order_ba_checklist WHERE id = ? AND order_id = ?`,
      [req.params.checklistId, req.params.id],
    );
    if (!item) return res.status(404).json({ success: false, message: 'Item checklist tidak ditemukan' });

    // Kalau item ini sebelumnya di-flag admin buat direvisi (ada
    // revision_note), berarti pengisian ini adalah "perbaikan" -- perlu
    // dikasih tau balik ke Admin biar mereka cek & bisa lanjut close.
    // Kalau bukan (pengisian pertama biasa), gak perlu notif staff sama
    // sekali (biar gak spam tiap 1 dari 14 item diisi).
    const wasRevision = !!item.revision_note;

    const conn = await pool.getConnection();
    try {
      if (item.template_type === 'text') {
        const { text_value } = req.body;
        if (!text_value || !text_value.trim()) {
          return res.status(400).json({ success: false, message: 'text_value wajib diisi untuk item ini' });
        }
        const inputSn = text_value.trim();

        // Cek pencocokan jika ada unit yang diekspektasikan (di-pre-assign admin)
        let matchStatus = 'N/A';
        const [[ord]] = await conn.query(`SELECT site_id FROM oki_orders WHERE id = ?`, [req.params.id]);

        if (item.expected_perangkat_id) {
          const [[expected]] = await conn.query(`SELECT serial_number FROM oki_perangkat WHERE id = ?`, [item.expected_perangkat_id]);
          if (expected) {
            matchStatus = expected.serial_number.trim().toLowerCase() === inputSn.toLowerCase() ? 'MATCH' : 'MISMATCH';
          }
        }

        // AUTO SYNC KE MASTER PERANGKAT (Selalu dilakukan, baik MATCH, MISMATCH, atau tidak ada ekspektasi)
        const [[existing]] = await conn.query(`SELECT id FROM oki_perangkat WHERE serial_number = ?`, [inputSn]);

        if (existing) {
          // Update unit yang sudah ada menjadi terpasang di site ini
          await conn.query(`UPDATE oki_perangkat SET status='TERPAKAI', site_id=? WHERE id = ?`, [ord.site_id, existing.id]);
        } else {
          // Insert sebagai unit baru di Master Perangkat
          await conn.query(
            `INSERT INTO oki_perangkat (nama_perangkat, kategori, serial_number, status, site_id) VALUES (?, ?, ?, 'TERPAKAI', ?)`,
            [item.template_name, item.category, inputSn, ord.site_id]
          );
        }

        await conn.query(
          `UPDATE oki_order_ba_checklist
           SET status='DONE', text_value=?, filled_by_technician_id=?, filled_at=NOW(), revision_note=NULL,
               match_status=?, mismatch_note=NULL
           WHERE id = ?`,
          [inputSn, req.user.id, matchStatus, item.id],
        );

        // MISMATCH itu kejadian penting -- langsung kasih tau Admin biar direview
        if (matchStatus === 'MISMATCH') {
          const [[tech]] = await conn.query(`SELECT nama FROM oki_technicians WHERE id = ?`, [req.user.id]);
          await logTimeline(
            req.params.id, 'NOTE',
            `${tech.nama} input SN "${inputSn}" untuk "${item.template_name}" TIDAK COCOK dengan unit yang di-assign (Master otomatis diperbarui). Perlu direview Admin.`,
            'TECHNICIAN', req.user.id, ['ADMIN'],
          );
        }
      } else {
        // template_type === 'file'
        if (!req.files || !req.files.length) {
          return res.status(400).json({ success: false, message: 'Upload 1 file untuk item ini' });
        }
        const saved = await saveFiles(conn, req.params.id, 'PEKERJAAN_BA', [req.files[0]], req.user.id, item.id, item.template_name, 'TECHNICIAN');
        await conn.query(
          `UPDATE oki_order_ba_checklist
           SET status='DONE', file_id=?, filled_by_technician_id=?, filled_at=NOW(), revision_note=NULL
           WHERE id = ?`,
          [saved[0].id, req.user.id, item.id],
        );
      }

      const [[tech]] = await conn.query(`SELECT nama FROM oki_technicians WHERE id = ?`, [req.user.id]);
      const msg = wasRevision
        ? `${tech.nama} sudah revisi ulang checklist BA: ${item.template_name}`
        : `${tech.nama} mengisi checklist BA: ${item.template_name}`;
      await logTimeline(req.params.id, 'NOTE', msg, 'TECHNICIAN', req.user.id, wasRevision ? ['ADMIN'] : []);
      await notifyOrderChanged(req.params.id);
      return res.json({ success: true, message: 'Item checklist berhasil diisi' });
    } finally {
      conn.release();
    }
  } catch (e) {
    console.error('[ORDER ba-checklist]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   BARU: POST /api/orders/:id/ba-checklist/:checklistId/revisi — HANYA ADMIN
   Nge-flag 1 item checklist yang UDAH diisi teknisi (status DONE) tapi
   ternyata gak sesuai -- balikin status ke PENDING + simpen alasannya di
   revision_note (WAJIB diisi). Teknisi bakal:
     - lihat catatan revisi ini di Timeline Pekerjaan (web & app)
     - dapet push notification + event socket real-time
     - masih bisa isi ulang item itu lewat endpoint di atas selama order
       belum di-CLOSE (revision_note otomatis ke-clear pas berhasil isi ulang)
   Order gak bisa di-CLOSE selama masih ada item checklist BA yang PENDING
   (lihat POST /:id/close) -- jadi revisi ini otomatis nge-block close
   sampai teknisi betulin & item-nya DONE lagi.
   body: { note } (wajib)
═══════════════════════════════════════════════════ */
/* ═══════════════════════════════════════════════════
   BARU: POST /api/orders/:id/ba-checklist/:checklistId/assign-perangkat
   — HANYA ADMIN
   Pre-assign 1 unit perangkat spesifik (dari Master Perangkat, biasanya
   status TERSEDIA) ke item checklist BA tipe 'text' (SN) SEBELUM teknisi
   berangkat. Pas teknisi input SN di lapangan, otomatis dicocokkan ke
   serial_number unit ini (lihat POST .../ba-checklist/:checklistId).
   body: { perangkat_id }
═══════════════════════════════════════════════════ */
router.post('/:id/ba-checklist/:checklistId/assign-perangkat', requireRole('ADMIN'), async (req, res) => {
  const { perangkat_id } = req.body;
  if (!perangkat_id) return res.status(400).json({ success: false, message: 'perangkat_id wajib diisi' });
  try {
    const [[item]] = await pool.query(
      `SELECT * FROM oki_order_ba_checklist WHERE id = ? AND order_id = ?`,
      [req.params.checklistId, req.params.id],
    );
    if (!item) return res.status(404).json({ success: false, message: 'Item checklist tidak ditemukan' });
    if (item.template_type !== 'text') {
      return res.status(400).json({ success: false, message: 'Pre-assign perangkat cuma berlaku buat item tipe text (SN)' });
    }
    const [[perangkat]] = await pool.query(`SELECT id, nama_perangkat FROM oki_perangkat WHERE id = ?`, [perangkat_id]);
    if (!perangkat) return res.status(404).json({ success: false, message: 'Perangkat tidak ditemukan' });

    await pool.query(`UPDATE oki_order_ba_checklist SET expected_perangkat_id = ? WHERE id = ?`, [perangkat_id, item.id]);
    return res.json({ success: true, message: `Unit "${perangkat.nama_perangkat}" berhasil di-assign ke item "${item.template_name}"` });
  } catch (e) {
    console.error('[ORDER assign-perangkat]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   BARU: POST /api/orders/:id/ba-checklist/:checklistId/resolve-mismatch
   — HANYA ADMIN
   SN yang diinput teknisi gak cocok sama unit yang di-pre-assign.
   2 mode:
     1. confirm_swap = false/gak dikirim -> cuma tandai "diterima", gak
        ngubah apa-apa di Master Perangkat (dipakai kalau ternyata cuma
        salah ketik dari teknisi, bukan beneran ganti unit).
     2. confirm_swap = true -> DIANGGAP UNIT BENERAN DIGANTI. Otomatis:
        - Cari perangkat di Master Perangkat yang serial_number-nya
          cocok sama text_value yang diinput teknisi (unit "baru").
          Kalau ketemu, statusnya diupdate jadi TERPAKAI + site_id order
          ini. Kalau gak ketemu di master sama sekali, dilewat (perlu
          didaftarkan manual dulu di Master Perangkat oleh admin).
        - Unit LAMA (yang sebelumnya di expected_perangkat_id) diupdate
          statusnya jadi old_unit_status (default 'RUSAK').
        - Unit Default di TEMPLATE BA (oki_site_ba_template) di-update
          ke unit baru -- biar order-order berikutnya ke site ini
          OTOMATIS ngarepin unit baru ini, gak perlu di-assign manual lagi.
   body: { note (wajib), confirm_swap?, old_unit_status? }
═══════════════════════════════════════════════════ */
router.post('/:id/ba-checklist/:checklistId/resolve-mismatch', requireRole('ADMIN'), async (req, res) => {
  const { note, confirm_swap, old_unit_status } = req.body;
  if (!note || !note.trim()) {
    return res.status(400).json({ success: false, message: 'Keterangan wajib diisi (misal alasan kenapa unit beda tetap diterima)' });
  }
  try {
    const [[item]] = await pool.query(
      `SELECT * FROM oki_order_ba_checklist WHERE id = ? AND order_id = ?`,
      [req.params.checklistId, req.params.id],
    );
    if (!item) return res.status(404).json({ success: false, message: 'Item checklist tidak ditemukan' });
    if (item.match_status !== 'MISMATCH') {
      return res.status(409).json({ success: false, message: 'Item ini gak dalam status mismatch, gak ada yang perlu di-resolve' });
    }

    await pool.query(`UPDATE oki_order_ba_checklist SET mismatch_note = ? WHERE id = ?`, [note.trim(), item.id]);

    let swapMessage = '';
    if (confirm_swap) {
      const [[ord]] = await pool.query(`SELECT site_id FROM oki_orders WHERE id = ?`, [req.params.id]);
      const [[newUnit]] = await pool.query(`SELECT id, nama_perangkat FROM oki_perangkat WHERE serial_number = ?`, [item.text_value]);

      if (newUnit) {
        await pool.query(`UPDATE oki_perangkat SET status='TERPAKAI', site_id=? WHERE id = ?`, [ord.site_id, newUnit.id]);
        // Update Unit Default di template BA -- order berikutnya ke site
        // ini otomatis ngarepin unit baru ini, gak perlu assign manual lagi.
        if (item.template_id) {
          await pool.query(`UPDATE oki_site_ba_template SET default_perangkat_id = ? WHERE id = ?`, [newUnit.id, item.template_id]);
        }
        swapMessage = ` Unit baru (${newUnit.nama_perangkat}) diupdate jadi TERPAKAI & jadi unit default site ini.`;
      } else {
        swapMessage = ' Unit baru belum terdaftar di Master Perangkat -- daftarkan dulu manual biar ke-track.';
      }

      if (item.expected_perangkat_id) {
        await pool.query(`UPDATE oki_perangkat SET status=? WHERE id = ?`, [old_unit_status || 'RUSAK', item.expected_perangkat_id]);
        swapMessage += ` Unit lama ditandai ${old_unit_status || 'RUSAK'}.`;
      }
    }

    await logTimeline(
      req.params.id, 'NOTE',
      `Admin resolve mismatch SN "${item.template_name}": ${note.trim()}${confirm_swap ? ' (konfirmasi penggantian unit)' : ''}`,
      'USER', req.user.id, [],
    );
    await notifyOrderChanged(req.params.id);
    return res.json({ success: true, message: `Mismatch berhasil di-resolve, order bisa dilanjutkan ke Close.${swapMessage}` });
  } catch (e) {
    console.error('[ORDER resolve-mismatch]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/:id/ba-checklist/:checklistId/revisi', requireRole('ADMIN'), async (req, res) => {
  const { note } = req.body;
  if (!note || !note.trim()) {
    return res.status(400).json({ success: false, message: 'Keterangan alasan revisi wajib diisi' });
  }
  try {
    const [[order]] = await pool.query(`SELECT status FROM oki_orders WHERE id = ?`, [req.params.id]);
    if (!order) return res.status(404).json({ success: false, message: 'Order tidak ditemukan' });
    if (order.status === 'CLOSED') {
      return res.status(409).json({ success: false, message: 'Order sudah ditutup, tidak bisa direvisi lagi' });
    }

    const [[item]] = await pool.query(
      `SELECT * FROM oki_order_ba_checklist WHERE id = ? AND order_id = ?`,
      [req.params.checklistId, req.params.id],
    );
    if (!item) return res.status(404).json({ success: false, message: 'Item checklist tidak ditemukan' });
    if (item.status !== 'DONE') {
      return res.status(409).json({ success: false, message: 'Item ini belum diisi teknisi, belum ada yang perlu direvisi' });
    }

    await pool.query(
      `UPDATE oki_order_ba_checklist SET status='PENDING', revision_note=? WHERE id = ?`,
      [note.trim(), item.id],
    );

    // Log ke timeline (kebaca teknisi juga di Timeline Pekerjaan mereka),
    // tapi SENGAJA skip notif bell staff -- ini urusan teknisi, bukan staff lain.
    await logTimeline(
      req.params.id, 'NOTE',
      `Admin minta revisi checklist BA "${item.template_name}": ${note.trim()}`,
      'USER', req.user.id, [],
    );

    // Push + socket LANGSUNG ke teknisi yang assigned, biar gak cuma
    // nunggu mereka buka app buat sadar ada yang perlu dibetulin.
    const [assignedTechs] = await pool.query(
      `SELECT technician_id FROM oki_order_technicians WHERE order_id = ? AND status = 'ASSIGNED'`,
      [req.params.id],
    );
    for (const t of assignedTechs) {
      emitToTechnician(t.technician_id, 'ba-revision-requested', {
        orderId: Number(req.params.id), checklistId: item.id, templateName: item.template_name, note: note.trim(),
      });
      sendPushToTechnician(
        t.technician_id, 'Perlu Revisi Checklist BA',
        `${item.template_name}: ${note.trim()}`,
        { orderId: req.params.id, type: 'ba-revision' },
      );
    }

    await notifyOrderChanged(req.params.id);
    return res.json({ success: true, message: 'Item checklist ditandai perlu revisi, teknisi sudah diberi tahu' });
  } catch (e) {
    console.error('[ORDER ba-checklist revisi]', e.message);
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
      const saved = await saveFiles(conn, req.params.id, 'KEBUTUHAN', req.files, req.user.id, Number(req.params.kebutuhanId));
      urls = saved.map(s => s.url);
      await conn.query(`UPDATE oki_order_kebutuhan SET bukti_url = ? WHERE id = ?`, [urls[0], req.params.kebutuhanId]);
    }
    await logTimeline(req.params.id, 'NOTE', 'Finance menandai 1 kebutuhan pra-assign sudah dibeli', 'USER', req.user.id, ['ADMIN']);
    await notifyOrderChanged(req.params.id);
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
        const saved = await saveFiles(conn, req.params.id, 'BIAYA', req.files, req.user.id, Number(req.params.biayaId));
        urls = saved.map(s => s.url);
      }
      await conn.query(`UPDATE oki_order_biaya SET status='DONE', paid_by=?, paid_at=NOW() WHERE id = ?`, [req.user.id, req.params.biayaId]);
      await logTimeline(req.params.id, 'NOTE', `Finance transfer biaya ${biaya.jenis} (${biaya.deskripsi || '-'}) selesai`, 'USER', req.user.id, ['ADMIN']);
      await notifyOrderChanged(req.params.id);
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
   BARU: khusus transisi ke DONE, DIBLOKIR kalau masih ada item checklist
   BA yang PENDING (kalau order ini gak punya BA, otomatis 0 pending,
   gak ada perubahan behavior buat customer yang belum pakai BA).
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

    // BARU: blokir DONE kalau checklist BA belum lengkap semua.
    if (status === 'DONE') {
      const pendingBa = await countPendingBaChecklist(req.params.id);
      if (pendingBa > 0) {
        return res.status(409).json({
          success: false,
          message: `Masih ada ${pendingBa} item checklist BA yang belum diisi. Lengkapi dulu sebelum menyelesaikan order.`,
        });
      }
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

    // BARU: blokir close kalau masih ada checklist BA yang PENDING --
    // baik yang emang belum sempat diisi teknisi, MAUPUN yang lagi
    // ditandai perlu revisi admin (lihat POST .../ba-checklist/:id/revisi).
    const [[{ pendingBa }]] = await pool.query(
      `SELECT COUNT(*) AS pendingBa FROM oki_order_ba_checklist WHERE order_id = ? AND status = 'PENDING'`, [req.params.id],
    );
    if (pendingBa > 0) {
      return res.status(409).json({ success: false, message: `Masih ada ${pendingBa} item checklist BA yang belum lengkap/perlu revisi teknisi` });
    }

    // BARU: blokir close kalau ada SN yang MISMATCH tapi belum di-resolve
    // admin (mismatch_note masih kosong) -- lihat POST .../resolve-mismatch.
    const [[{ unresolvedMismatch }]] = await pool.query(
      `SELECT COUNT(*) AS unresolvedMismatch FROM oki_order_ba_checklist WHERE order_id = ? AND match_status = 'MISMATCH' AND mismatch_note IS NULL`, [req.params.id],
    );
    if (unresolvedMismatch > 0) {
      return res.status(409).json({ success: false, message: `Masih ada ${unresolvedMismatch} SN yang tidak cocok dan belum di-resolve admin` });
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


/* ═══════════════════════════════════════════════════
   GET /api/orders/pending/mine — HANYA TEKNISI
   Daftar order yang SUDAH diterima (ACCEPTED) teknisi ini tapi BELUM
   di-assign final oleh admin. Supaya order gak "hilang" dari pandangan
   teknisi selagi nunggu konfirmasi.
   PENTING: harus didaftarkan SEBELUM GET /:id biar 'pending' gak
   ketangkep jadi :id.
═══════════════════════════════════════════════════ */
router.get('/pending/mine', requireTechnician, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT o.id, o.order_no, o.category, o.priority, o.wilayah, o.description,
              o.tanggal_mulai, o.tanggal_selesai_target, c.nama_perusahaan, ot.responded_at AS accepted_at
       FROM oki_order_technicians ot
       JOIN oki_orders o ON o.id = ot.order_id
       JOIN oki_customers c ON c.id = o.customer_id
       WHERE ot.technician_id = ? AND ot.status = 'ACCEPTED'
       ORDER BY ot.responded_at DESC`,
      [req.user.id],
    );
    return res.json({ success: true, pending: rows });
  } catch (e) {
    console.error('[ORDER pending/mine]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;