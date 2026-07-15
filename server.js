const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const http = require('http');
require('dotenv').config();

const { initSocket } = require('./socket');

const authRoute       = require('./routes/auth.route');
const customerRoute   = require('./routes/customer.route');
const technicianRoute = require('./routes/technician.route');
const orderRoute      = require('./routes/order.route');
const dashboardRoute  = require('./routes/dashboard.route');
const siteRoute       = require('./routes/site.route');

const app = express();
const PORT = process.env.PORT || 3010;

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoute);
app.use('/api/customers', customerRoute);
app.use('/api/technicians', technicianRoute);
app.use('/api/orders', orderRoute);
app.use('/api/dashboard', dashboardRoute);
app.use('/api/sites', siteRoute);

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// File bukti transfer yang diupload Finance (screenshot/PDF struk TF)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

/* ═══════════════════════════════════════════════════
   CLEAN URL — sembunyiin ekstensi .html.
   1) Kalau ada yang buka /sesuatu.html langsung, redirect permanen ke
      /sesuatu (biar .html gak pernah muncul/tersimpan di address bar,
      history, atau bookmark orang lain).
   2) /sesuatu (tanpa ekstensi) di-serve dari public/sesuatu.html kalau
      filenya ada. Ini dipasang SEBELUM express.static(public) supaya
      diproses duluan, tapi SETELAH semua route /api & /health di atas
      supaya gak ketabrak.
═══════════════════════════════════════════════════ */
const PUBLIC_DIR = path.join(__dirname, 'public');

app.get(/^\/([\w-]+)\.html$/, (req, res) => {
  res.redirect(301, `/${req.params[0]}`);
});

app.get(/^\/([\w-]+)$/, (req, res, next) => {
  const filePath = path.join(PUBLIC_DIR, `${req.params[0]}.html`);
  fs.access(filePath, fs.constants.F_OK, (err) => {
    if (err) return next(); // bukan halaman .html yang dikenal -> lanjut ke static/404 biasa
    res.sendFile(filePath);
  });
});

// Dashboard web (frontend statis) — satu server buat API + tampilan,
// gak perlu jalanin proses/port terpisah lagi.
app.use(express.static(path.join(__dirname, 'public')));

const httpServer = http.createServer(app);
initSocket(httpServer);

httpServer.listen(PORT, () => {
  console.log(`🚀 OKI Maintenance System jalan di http://localhost:${PORT}`);
  console.log(`   🖥️  Dashboard: http://localhost:${PORT}/`);
  console.log(`   POST /api/auth/login`);
  console.log(`   POST /api/auth/login-technician`);
  console.log(`   GET  /api/customers`);
  console.log(`   GET  /api/technicians`);
  console.log(`   POST /api/technicians/:id/status`);
  console.log(`   POST /api/technicians/:id/location   (GPS, tiap 30 detik saat READY)`);
  console.log(`   GET  /api/orders`);
  console.log(`   GET  /api/orders/offers/mine          (teknisi: tawaran tugas nunggu respon)`);
  console.log(`   GET  /api/orders/:id                  (termasuk assign_eligibility)`);
  console.log(`   POST /api/orders`);
  console.log(`   PUT  /api/orders/:id                  (edit, cuma saat status masih NEW)`);
  console.log(`   POST /api/orders/:id/approve`);
  console.log(`   POST /api/orders/:id/reject`);
  console.log(`   POST /api/orders/:id/plan-technician         (admin: flag/tawarin teknisi)`);
  console.log(`   DELETE /api/orders/:id/plan-technician/:techId`);
  console.log(`   POST /api/orders/:id/respond                 (teknisi: terima/tolak tawaran)`);
  console.log(`   POST /api/orders/:id/kebutuhan/:kid/dibeli    (finance)`);
  console.log(`   POST /api/orders/:id/biaya/:biayaId/bayar     (finance, per-item, aturan sebelum/sesudah)`);
  console.log(`   POST /api/orders/:id/assign          (konfirmasi final, server-side enforce eligibility)`);
  console.log(`   POST /api/orders/:id/status           (HANYA teknisi utk progres; admin cuma CANCELLED)`);
  console.log(`   POST /api/orders/:id/close            (admin: tutup tiket final)`);
  console.log(`   GET  /api/dashboard/kpi`);
  console.log(`   GET  /api/dashboard/monitoring`);
  console.log(`   GET  /api/dashboard/analytics`);
  console.log(`🔌 Socket.IO aktif (register-dashboard / register-technician)`);
  console.log(`   GET  /health`);
});