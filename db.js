// const mysql = require('mysql2/promise');
// require('dotenv').config();

// const pool = mysql.createPool({
//   host: process.env.DB_HOST || 'localhost',
//   user: process.env.DB_USER || 'root',
//   password: process.env.DB_PASSWORD || '',
//   database: process.env.DB_NAME || 'oki_maintenance',
//   port: process.env.DB_PORT || 3306,
//   waitForConnections: true,
//   connectionLimit: 10,
//   queueLimit: 0,
//   dateStrings: true, // biar DATETIME balik sebagai string, bukan objek Date (konsisten dgn frontend)
//   timezone: '+07:00',
// });

// module.exports = pool;

const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'oki_maintenance',
  port: process.env.DB_PORT || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true, // biar DATETIME balik sebagai string, bukan objek Date (konsisten dgn frontend)
});

// PENTING: opsi `timezone: '+07:00'` di config createPool() TIDAK cukup di
// sini — itu cuma ngatur konversi di sisi JS, sedangkan kita pakai
// dateStrings:true (MySQL ngirim string mentah, gak dikonversi sama
// sekali). Yang beneran nentuin isi NOW()/CURRENT_TIMESTAMP adalah
// timezone SESSION di server MySQL-nya sendiri (`@@session.time_zone`,
// yang kepasang ke `SYSTEM` = ikut OS server, dan OS server itu ternyata
// UTC bukan WIB). Makanya di sini kita SET time_zone eksplisit tiap kali
// ada koneksi baru dibikin di pool — ini yang beneran mindahin jam
// NOW()/CURRENT_TIMESTAMP ke WIB.
pool.on('connection', (connection) => {
  connection.query("SET time_zone = '+07:00'");
});

module.exports = pool;