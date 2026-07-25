const { Server } = require('socket.io');

let io = null;

function initSocket(httpServer) {
  io = new Server(httpServer, { cors: { origin: '*' } });

  io.on('connection', (socket) => {
    console.log('[SOCKET] Client connected:', socket.id);

    // Dashboard web join room ini buat dapet update KPI/monitoring realtime
    // -- SEMUA staff tetap join ini apapun role-nya (buat KPI, jumlah
    // order per status, dll yang emang relevan buat semua role).
    // Kalau client kirim { role } sekalian, JOIN JUGA room khusus role itu
    // (dashboard-role-ADMIN, dashboard-role-FINANCE, dst) -- ini yang
    // dipakai buat notifikasi TERTARGET per role (lihat emitToDashboardRoles).
    socket.on('register-dashboard', (payload) => {
      socket.join('dashboard');
      const role = payload && payload.role;
      if (role) socket.join(`dashboard-role-${role}`);
    });

    // Teknisi mobile/app join room pribadinya (buat notif assignment, dsb)
    socket.on('register-technician', (technicianId) => {
      socket.join(`technician-${technicianId}`);
    });

    socket.on('disconnect', () => {
      console.log('[SOCKET] Client disconnected:', socket.id);
    });
  });

  return io;
}

function emitToDashboard(event, payload) {
  if (io) io.to('dashboard').emit(event, payload);
}

/* BARU: kirim event cuma ke staff dengan role tertentu (misal notifikasi
   order butuh approval cuma relevan buat ATASAN, bukan semua staff).
   roles: array string, misal ['ADMIN', 'FINANCE']. Kalau kosong/gak ada
   role match, gak ngirim apa-apa (bukan fallback ke broadcast semua). */
function emitToDashboardRoles(roles, event, payload) {
  if (!io || !roles || !roles.length) return;
  io.to(roles.map(r => `dashboard-role-${r}`)).emit(event, payload);
}

function emitToTechnician(technicianId, event, payload) {
  if (io) io.to(`technician-${technicianId}`).emit(event, payload);
}

module.exports = { initSocket, emitToDashboard, emitToDashboardRoles, emitToTechnician };