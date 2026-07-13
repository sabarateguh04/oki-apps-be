const fs = require('fs');
const path = require('path');
const multer = require('multer');

/* File bukti transfer (screenshot/PDF struk TF) disimpan di:
     <project-root>/uploads/bukti/
   dan diakses publik lewat: http://<host>/uploads/bukti/<namafile>
   (di-serve statis lewat express.static di server.js) */
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'bukti');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '';
    const safeBase = path
      .basename(file.originalname, ext)
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 40);
    cb(null, `${Date.now()}-${safeBase}${ext}`);
  },
});

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];

const uploadBukti = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      return cb(new Error('Format file harus JPG, PNG, WEBP, atau PDF'));
    }
    cb(null, true);
  },
});

/** Path relatif (buat disimpan ke DB & dipakai <img src>/<a href> di frontend) */
function publicUrlFor(filename) {
  return `/uploads/bukti/${filename}`;
}

/** Bungkus multer supaya errornya (ukuran kegedean, format salah, dll)
 *  balik sebagai JSON rapi, bukan crash / HTML error Express default. */
function handleUpload(fieldName) {
  return (req, res, next) => {
    uploadBukti.single(fieldName)(req, res, (err) => {
      if (err) return res.status(400).json({ success: false, message: err.message });
      next();
    });
  };
}

/** Sama kayak handleUpload tapi terima BANYAK file sekaligus (mis. bukti
 *  transfer > 1 lembar, atau lampiran pendukung > 1 file). */
function handleUploadMultiple(fieldName, maxCount = 10) {
  return (req, res, next) => {
    uploadBukti.array(fieldName, maxCount)(req, res, (err) => {
      if (err) return res.status(400).json({ success: false, message: err.message });
      next();
    });
  };
}

module.exports = { uploadBukti, publicUrlFor, handleUpload, handleUploadMultiple };
