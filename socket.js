const { Server } = require('socket.io');

let io = null;

function initSocket(httpServer) {
  io = new Server(httpServer, { cors: { origin: '*' } });

  io.on('connection', (socket) => {
    console.log('[SOCKET] Client connected:', socket.id);

    // Dashboard web join room ini buat dapet update KPI/monitoring realtime
    socket.on('register-dashboard', () => {
      socket.join('dashboard');
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

function emitToTechnician(technicianId, event, payload) {
  if (io) io.to(`technician-${technicianId}`).emit(event, payload);
}

module.exports = { initSocket, emitToDashboard, emitToTechnician };
