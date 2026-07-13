/**
 * Menentukan apakah order boleh di-"Konfirmasi & Assign" FINAL, plus alasan
 * blok-nya kalau belum boleh.
 *
 * ALUR LENGKAPNYA:
 *   1. Admin nge-flag (tawarin) 1+ teknisi -> status PLANNED. Ini BOLEH
 *      kapan aja, gak dicek fungsi ini sama sekali.
 *   2. Teknisi yang ditawarin ACCEPT atau REJECT. Kalau REJECT, admin
 *      tawarin ke teknisi lain (flag baru).
 *   3. Begitu ADA teknisi yang ACCEPTED, DAN semua syarat di bawah lolos,
 *      admin baru bisa klik "Konfirmasi & Assign" -> baris ACCEPTED
 *      dipromosikan jadi ASSIGNED (final, teknisi baru boleh mulai kerja).
 *
 * SYARAT (semua harus lolos):
 *   CONDITION 1: Atasan sudah APPROVE order ini?
 *   CONDITION 2: Semua kebutuhan pra-assign (barang yang wajib dibeli,
 *                mis. modem/sparepart) sudah berstatus DIBELI?
 *   CONDITION 3: Semua rincian biaya dengan timing_bayar = SEBELUM
 *                (mis. transport, uang makan, DP material) sudah
 *                ditransfer Finance (status DONE)? Biaya SESUDAH (mis.
 *                jasa teknisi) TIDAK ngeblok assign — itu baru dibayar
 *                Finance setelah order selesai dikerjakan (DONE).
 *   CONDITION 4: Ada minimal 1 teknisi yang statusnya ACCEPTED?
 *
 * @param {object} order - row dari tabel `oki_orders`
 * @param {number} pendingKebutuhanCount - jumlah item kebutuhan pra-assign yang masih PENDING
 * @param {number} pendingBiayaSebelumCount - jumlah baris biaya timing SEBELUM yang masih PENDING
 * @param {number} acceptedTechnicianCount - jumlah teknisi berstatus ACCEPTED di order ini
 * @param {number} assignedTechnicianCount - jumlah teknisi yang statusnya sudah ASSIGNED
 * @returns {{ eligible: boolean, reason: string|null, blockedAt: string|null }}
 */
function getAssignEligibility(
  order,
  pendingKebutuhanCount = 0,
  pendingBiayaSebelumCount = 0,
  acceptedTechnicianCount = 0,
  assignedTechnicianCount = 0,
) {
  if (order.approval_status !== 'APPROVED') {
    return { eligible: false, reason: 'Menunggu approval atasan', blockedAt: 'APPROVAL' };
  }

  if (pendingKebutuhanCount > 0) {
    return {
      eligible: false,
      reason: `Masih ada ${pendingKebutuhanCount} kebutuhan yang belum dibeli/ditransfer`,
      blockedAt: 'KEBUTUHAN_PRA_ASSIGN',
    };
  }

  if (pendingBiayaSebelumCount > 0) {
    return {
      eligible: false,
      reason: `Masih ada ${pendingBiayaSebelumCount} biaya (timing "Sebelum") yang belum ditransfer Finance`,
      blockedAt: 'BIAYA_SEBELUM',
    };
  }

  if (assignedTechnicianCount > 0) {
    return { eligible: false, reason: 'Order ini sudah punya teknisi yang ditugaskan', blockedAt: 'ALREADY_ASSIGNED' };
  }

  if (acceptedTechnicianCount === 0) {
    return {
      eligible: false,
      reason: 'Belum ada teknisi yang menerima tawaran tugas ini',
      blockedAt: 'NO_ACCEPTED_TECHNICIAN',
    };
  }

  if (['DONE', 'CLOSED', 'CANCELLED', 'REJECTED'].includes(order.status)) {
    return { eligible: false, reason: `Order berstatus ${order.status}, tidak bisa di-assign`, blockedAt: 'TERMINAL_STATUS' };
  }

  return { eligible: true, reason: null, blockedAt: null };
}

module.exports = { getAssignEligibility };
