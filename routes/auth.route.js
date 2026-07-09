const express = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');

const router = express.Router();

/* ═══════════════════════════════════════════════════
   POST /api/auth/login
   Login staff (admin / atasan / finance / dispatcher)
═══════════════════════════════════════════════════ */
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'username & password wajib diisi' });
  }

  try {
    const [rows] = await pool.query(
      `SELECT id, username, password, nama, role FROM oki_users WHERE username = ? AND is_active = 1 LIMIT 1`,
      [username],
    );
    if (rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Username atau password salah' });
    }

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password);
    if (!match) {
      return res.status(401).json({ success: false, message: 'Username atau password salah' });
    }

    return res.json({
      success: true,
      userId: user.id,
      username: user.username,
      nama: user.nama,
      role: user.role,
    });
  } catch (e) {
    console.error('[AUTH login]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ═══════════════════════════════════════════════════
   POST /api/auth/login-technician
   Login teknisi (dipakai dari mobile/app teknisi)
═══════════════════════════════════════════════════ */
router.post('/login-technician', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'username & password wajib diisi' });
  }

  try {
    const [rows] = await pool.query(
      `SELECT id, username, password, nama, no_hp, email, status
       FROM oki_technicians WHERE username = ? AND is_active = 1 LIMIT 1`,
      [username],
    );
    if (rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Username atau password salah' });
    }

    const tech = rows[0];
    const match = await bcrypt.compare(password, tech.password);
    if (!match) {
      return res.status(401).json({ success: false, message: 'Username atau password salah' });
    }

    return res.json({
      success: true,
      technicianId: tech.id,
      username: tech.username,
      nama: tech.nama,
      status: tech.status,
    });
  } catch (e) {
    console.error('[AUTH login-technician]', e.message);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;