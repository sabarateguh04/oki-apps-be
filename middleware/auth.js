const jwt = require('jsonwebtoken');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'oki-maintenance-dev-secret-CHANGE-ME';

/**
 * INI YANG NGE-ENFORCE ROLE-BASED ACCESS CONTROL DI SISI SERVER.
 * Sebelumnya sistem cuma nyembunyiin tombol di frontend (bisa di-bypass
 * dengan manggil API langsung / lewat Postman). Sekarang tiap request wajib
 * bawa JWT token dari hasil login, dan tiap endpoint sensitif ngecek role-nya.
 *
 * Cara pakai di route:
 *   router.post('/approve', requireAuth, requireRole('ATASAN'), async (req,res)=>{...})
 *   req.user = { id, username, nama, role, type: 'staff' }  ATAU
 *   req.user = { id, username, nama, type: 'technician' }
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ success: false, message: 'Token tidak ditemukan, silakan login ulang' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch (e) {
    return res.status(401).json({ success: false, message: 'Sesi habis / token tidak valid, silakan login ulang' });
  }
}

/**
 * requireRole('ADMIN', 'ATASAN') -> lolos kalau req.user.role salah satu dari itu.
 * Harus dipasang SETELAH requireAuth.
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || req.user.type !== 'staff' || !roles.includes(req.user.role)) {
      return res.status(403).json({
        success: false,
        message: `Aksi ini hanya untuk role: ${roles.join(', ')}`,
      });
    }
    return next();
  };
}

/** Khusus endpoint yang boleh diakses teknisi (mobile app) */
function requireTechnician(req, res, next) {
  if (!req.user || req.user.type !== 'technician') {
    return res.status(403).json({ success: false, message: 'Aksi ini hanya untuk akun teknisi' });
  }
  return next();
}

function signStaffToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, nama: user.nama, role: user.role, type: 'staff' },
    JWT_SECRET,
    { expiresIn: '12h' },
  );
}

function signTechnicianToken(tech) {
  return jwt.sign(
    { id: tech.id, username: tech.username, nama: tech.nama, type: 'technician' },
    JWT_SECRET,
    { expiresIn: '12h' },
  );
}

module.exports = { requireAuth, requireRole, requireTechnician, signStaffToken, signTechnicianToken, JWT_SECRET };
