const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

/* ═══════════════════════════════════════════════════
   GET /api/dashboard/kpi
   Area 1: Ringkasan KPI (Total Order, Pending, Progress, Selesai, Approval)
═══════════════════════════════════════════════════ */
router.get('/kpi', async (req, res) => {
  try {
    const [[row]] = await pool.query(`
      SELECT
        COUNT(*)                                              AS total_order,
        SUM(status = 'NEW')                                   AS pending,
        SUM(status IN ('ASSIGNED','ON_THE_WAY','IN_PROGRESS')) AS progress,
        SUM(status = 'DONE')                                  AS selesai,
        SUM(approval_status = 'PENDING')                      AS approval_pending,
        SUM(status = 'REJECTED')                               AS rejected,
        SUM(status = 'CANCELLED')                              AS cancelled
      FROM oki_orders
    `);

    const [[techRow]] = await pool.query(`
      SELECT
        COUNT(*)                    AS total_teknisi,
        SUM(status = 'READY')       AS ready,
        SUM(status = 'ON_DUTY')     AS on_duty,
        SUM(status = 'OFFLINE')     AS offline
      FROM oki_technicians WHERE is_active = 1
    `);

    return res.json({ success: true, order_kpi: row, technician_kpi: techRow });
  } catch (e) {
    console.error('[DASHBOARD kpi]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   GET /api/dashboard/monitoring
   Area 2: Monitoring Operasional — order terbaru, aktivitas terbaru,
   teknisi online + lokasi (buat peta).
═══════════════════════════════════════════════════ */
router.get('/monitoring', async (req, res) => {
  try {
    const [recentOrders] = await pool.query(`
      SELECT o.id, o.order_no, o.status, o.priority, o.approval_status,
             c.nama_perusahaan, o.created_at,
             (SELECT GROUP_CONCAT(t.nama SEPARATOR ', ')
                FROM oki_order_technicians ot JOIN oki_technicians t ON t.id = ot.technician_id
                WHERE ot.order_id = o.id AND ot.status = 'ASSIGNED') AS technician_nama
      FROM oki_orders o
      JOIN oki_customers c ON c.id = o.customer_id
      ORDER BY o.created_at DESC
      LIMIT 10
    `);

    const [recentActivities] = await pool.query(`
      SELECT ot.id, ot.order_id, o.order_no, ot.event_type, ot.note,
             ot.actor_type, ot.actor_id, ot.created_at
      FROM oki_order_timeline ot
      JOIN oki_orders o ON o.id = ot.order_id
      ORDER BY ot.created_at DESC
      LIMIT 20
    `);

    const [technicianLocations] = await pool.query(`
      SELECT id, nama, status, latitude, longitude, last_location_at
      FROM oki_technicians
      WHERE is_active = 1 AND status IN ('READY','ON_DUTY') AND latitude IS NOT NULL
    `);

    return res.json({
      success: true,
      recent_orders: recentOrders,
      recent_activities: recentActivities,
      technician_locations: technicianLocations,
    });
  } catch (e) {
    console.error('[DASHBOARD monitoring]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   GET /api/dashboard/analytics
   Area 3: Analitik — order per bulan, performa teknisi, SLA/waktu
   penyelesaian.
═══════════════════════════════════════════════════ */
router.get('/analytics', async (req, res) => {
  try {
    const [orderPerMonth] = await pool.query(`
      SELECT DATE_FORMAT(created_at, '%Y-%m') AS bulan, COUNT(*) AS total
      FROM oki_orders
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
      GROUP BY bulan
      ORDER BY bulan ASC
    `);

    const [technicianPerformance] = await pool.query(`
      SELECT t.id, t.nama,
             COUNT(ot.order_id) AS total_order,
             SUM(o.status = 'DONE') AS total_selesai,
             ROUND(AVG(CASE WHEN o.status='DONE' THEN TIMESTAMPDIFF(MINUTE, o.assigned_at, o.selesai_at) END)) AS avg_durasi_menit
      FROM oki_technicians t
      LEFT JOIN oki_order_technicians ot ON ot.technician_id = t.id AND ot.status = 'ASSIGNED'
      LEFT JOIN oki_orders o ON o.id = ot.order_id
      WHERE t.is_active = 1
      GROUP BY t.id, t.nama
      ORDER BY total_selesai DESC
    `);

    // SLA: rata-rata waktu dari order dibuat sampai selesai, dipecah per prioritas
    const [slaByPriority] = await pool.query(`
      SELECT priority,
             COUNT(*) AS total_selesai,
             ROUND(AVG(TIMESTAMPDIFF(MINUTE, created_at, selesai_at))) AS avg_menit_dari_dibuat,
             ROUND(AVG(TIMESTAMPDIFF(MINUTE, assigned_at, selesai_at))) AS avg_menit_pengerjaan
      FROM oki_orders
      WHERE status = 'DONE' AND selesai_at IS NOT NULL
      GROUP BY priority
    `);

    return res.json({
      success: true,
      order_per_month: orderPerMonth,
      technician_performance: technicianPerformance,
      sla_by_priority: slaByPriority,
    });
  } catch (e) {
    console.error('[DASHBOARD analytics]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;