const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const pool = require('./db');
require('dotenv').config();

initializeApp({
  credential: cert(require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH)),
});

/* Kirim push ke 1 teknisi. Dipanggil BERPASANGAN sama emitToTechnician(),
   di titik yang sama, supaya teknisi yang app-nya lagi kebuka dapet lewat
   socket, dan yang app-nya idle/killed dapet lewat FCM. */
async function sendPushToTechnician(technicianId, title, body, data = {}) {
  try {
    const [[tech]] = await pool.query(
      `SELECT fcm_token FROM oki_technicians WHERE id = ?`,
      [technicianId]
    );

    if (!tech?.fcm_token) return;

    await getMessaging().send({
      token: tech.fcm_token,
      notification: {
        title,
        body,
      },
      data: Object.fromEntries(
        Object.entries(data).map(([k, v]) => [k, String(v)])
      ),
    });
  } catch (e) {
    console.error('[PUSH]', e.message);
  }
}

module.exports = { sendPushToTechnician };