const express = require('express');
const cors = require('cors');
const path = require('path');
const http = require('http');
require('dotenv').config();

const { initSocket } = require('./socket');

const authRoute       = require('./routes/auth.route');
const customerRoute   = require('./routes/customer.route');
const technicianRoute = require('./routes/technician.route');
const orderRoute      = require('./routes/order.route');
const dashboardRoute  = require('./routes/dashboard.route');

const app = express();
const PORT = process.env.PORT || 3010;

app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoute);
app.use('/api/customers', customerRoute);
app.use('/api/technicians', technicianRoute);
app.use('/api/orders', orderRoute);
app.use('/api/dashboard', dashboardRoute);

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

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
  console.log(`   GET  /api/orders/:id                 (termasuk assign_eligibility)`);
  console.log(`   POST /api/orders`);
  console.log(`   POST /api/orders/:id/approve`);
  console.log(`   POST /api/orders/:id/reject`);
  console.log(`   POST /api/orders/:id/pre-bayar-done`);
  console.log(`   POST /api/orders/:id/jasa-teknisi-done`);
  console.log(`   POST /api/orders/:id/assign          (server-side enforce assign eligibility)`);
  console.log(`   POST /api/orders/:id/status`);
  console.log(`   GET  /api/dashboard/kpi`);
  console.log(`   GET  /api/dashboard/monitoring`);
  console.log(`   GET  /api/dashboard/analytics`);
  console.log(`🔌 Socket.IO aktif (register-dashboard / register-technician)`);
  console.log(`   GET  /health`);
});
