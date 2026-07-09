/**
 * Menentukan apakah order boleh di-assign ke teknisi, plus alasan blok-nya
 * kalau belum boleh — persis logic dari flowchart "ASSIGN BUTTON VISIBILITY":
 *
 *   CONDITION 1: Atasan sudah APPROVE?
 *     NO  → HIDDEN, "Menunggu approval atasan"
 *   CONDITION 2: Pre-Bayar sudah SELESAI? (kalau ada pre-bayar)
 *     Ada pre-bayar & PENDING → HIDDEN, "Menunggu proses Finance untuk pre-bayar"
 *     Gak ada pre-bayar        → SKIP (dianggap selesai)
 *   CONDITION 3: Jasa Teknisi sudah DI-TRANSFER? (HANYA kalau bayar SEBELUM)
 *     timing SEBELUM & PENDING → HIDDEN, "Menunggu TF jasa teknisi"
 *     timing SESUDAH            → SKIP
 *
 * Dipakai di DUA tempat: endpoint GET order-detail (buat kasih tau frontend
 * apakah tombol Assign harus ditampilkan + alasan block-nya), dan endpoint
 * POST assign itu sendiri (buat nge-block request langsung ke API, bukan
 * cuma nyembunyiin tombol di UI — karena UI bisa di-bypass).
 *
 * @param {object} order - row dari tabel `orders`
 * @returns {{ eligible: boolean, reason: string|null, blockedAt: string|null }}
 */
function getAssignEligibility(order) {
  // CONDITION 1
  if (order.approval_status !== 'APPROVED') {
    return { eligible: false, reason: 'Menunggu approval atasan', blockedAt: 'APPROVAL' };
  }

  // CONDITION 2 (cuma dicek kalau order ini memang ada pre-bayar)
  if (order.has_pre_bayar && order.pre_bayar_status !== 'DONE') {
    return { eligible: false, reason: 'Menunggu proses Finance untuk pre-bayar', blockedAt: 'PRE_BAYAR' };
  }

  // CONDITION 3 (cuma dicek kalau timing pembayaran jasa teknisi = SEBELUM eksekusi)
  if (order.payment_timing === 'SEBELUM' && order.jasa_teknisi_transfer_status !== 'DONE') {
    return { eligible: false, reason: 'Menunggu TF jasa teknisi', blockedAt: 'JASA_TEKNISI_TF' };
  }

  // Guard tambahan di luar flowchart aslinya, tapi perlu supaya endpoint
  // gak bisa "assign ulang" order yang sudah ada teknisinya atau yang
  // statusnya sudah final. Hapus kalau memang gak diinginkan.
  if (order.technician_id) {
    return { eligible: false, reason: 'Order ini sudah punya teknisi yang ditugaskan', blockedAt: 'ALREADY_ASSIGNED' };
  }
  if (['DONE', 'CANCELLED', 'REJECTED'].includes(order.status)) {
    return { eligible: false, reason: `Order berstatus ${order.status}, tidak bisa di-assign`, blockedAt: 'TERMINAL_STATUS' };
  }

  return { eligible: true, reason: null, blockedAt: null };
}

module.exports = { getAssignEligibility };
