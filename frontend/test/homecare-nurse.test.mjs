import { test } from "bun:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionProvider } from "../components/session-provider";
import { NurseWorkspaceProvider } from "../components/nurse-workspace-provider";
import { SessionController } from "../lib/api/session";
import { getNurseWorkspace } from "../lib/api/workspaces";
import { createApiClient } from "../lib/api/client";
import { createHomecareApi } from "../lib/api/homecare";
import {
  NurseBookingSnapshot,
  NurseBookingRows,
  NurseScheduleRows,
  NursePriorityRequestContent,
  readNurseRequest,
  readNurseVisitSchedule,
  isNurseRescheduleTimely,
} from "../components/homecare-nurse";

const patientId = "da5fca18-0822-4001-b503-dd2fb9fca072";
const nurseId = "cb24dd80-d0ca-439a-b563-58ab724a3bea";
const bookingId = "ed2e4ce9-4774-4260-b242-27fa26040f17";
const priorityId = "0bca4a7f-a181-4515-a433-306f45d4e104";
const accountId = "c312c603-7d47-4c90-9d66-c387e391a988";
const time = "2026-11-14T01:00:00.000Z";
const later = "2026-11-15T01:00:00.000Z";
const end = "2026-11-15T02:00:00.000Z";
const intake = {
  complaint: "Demam sejak kemarin",
  otherComplaint: "Nyeri saat berjalan",
  history: "Sulit makan sejak dua hari lalu",
  consciousness: "alert",
  conditions: ["weak"],
  observations: [],
  note: "Mohon hubungi keluarga setelah kunjungan.",
  consent: true,
};
const profileSnapshot = {
  fullName: "Pasien Privat",
  birthDate: "1950-01-01",
  gender: "female",
  phone: "081111111111",
  addressLine: "Alamat Privat 1",
  recordNumber: "RM-PRIVAT",
  emergencyContactName: "Keluarga Privat",
  emergencyContactPhone: "082222222222",
};
const booking = {
  id: bookingId,
  patientId,
  nurseId,
  nurse: { id: nurseId, displayName: "Perawat Terpilih", staffCode: "N01" },
  slotId: null,
  availabilityVersionId: null,
  startsAt: later,
  endsAt: end,
  status: "submitted",
  version: 1,
  intake,
  profileSnapshot,
  visitId: null,
  priorityRequestId: priorityId,
  decisionReason: null,
  submittedAt: time,
  decidedAt: null,
  cancelledAt: null,
  createdAt: time,
  updatedAt: time,
  events: [],
};
const priority = {
  id: priorityId,
  bookingId,
  patientId,
  nurseId,
  startsAt: later,
  endsAt: end,
  statement: "Kunjungan perlu dilakukan di luar jadwal.",
  status: "pending",
  reason: null,
  version: 0,
  reviewedAt: null,
  createdAt: time,
  patient: { displayName: "Identitas Minimum", recordNumber: "RM-MINIMUM" },
};
const render = (Component, props) => renderToStaticMarkup(createElement(Component, props));
async function nurseController() {
  const session = {
    account: { id: accountId, email: "nurse@example.invalid", roles: ["nurse"], status: "active" },
    session: { csrfToken: "csrf", expiresAt: "2026-11-20T00:00:00Z" },
    access: { scopes: ["nurse:directory", "nurse:request_intake"], accessContexts: [] },
    displayTimeZone: "Asia/Jakarta",
    expiresAt: "2026-11-20T00:00:00Z",
    capabilities: {},
  };
  const controller = new SessionController({ fetch: async () => new Response(JSON.stringify({ data: session, requestId: priorityId })) });
  await controller.refresh();
  return controller;
}

test("nurse intake projection renders additional complaint and full note, not inferred clinical scores", () => {
  const html = render(NurseBookingSnapshot, { booking });
  assert.match(html, /Nyeri saat berjalan/);
  assert.match(html, /Mohon hubungi keluarga setelah kunjungan\./);
  assert.match(html, /Sulit makan sejak dua hari lalu/);
  assert.match(html, /Sadar penuh/);
  assert.doesNotMatch(html, /skor|risiko tinggi|normal<\/dd>/i);
});

for (const status of ["rejected", "cancelled"]) {
  test(`${status} booking with null snapshots hides contact, address and protected intake`, () => {
    const html = render(NurseBookingSnapshot, { booking: { ...booking, status, intake: null, profileSnapshot: null } });
    assert.match(html, /izin akses berakhir atau pengajuan sudah terminal/);
    assert.match(html, /Intake tidak tersedia/);
    for (const privateText of [...Object.values(profileSnapshot).filter(Boolean), ...Object.values(intake).filter(value => typeof value === "string")]) {
      assert.doesNotMatch(html, new RegExp(privateText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.doesNotMatch(html, /081111111111|Alamat Privat|Kontak darurat/);
  });
}

test("private-draft priority read uses only the selected-nurse priority endpoint and passes abort signal", async () => {
  const calls = [];
  const homecare = {
    priorityRequest: async (id, signal) => {
      calls.push({ method: "priorityRequest", id, signal });
      return priority;
    },
    booking: async id => {
      calls.push({ method: "booking", id });
      throw new Error("Private draft is intentionally unreadable (404).");
    },
  };
  const controller = new AbortController();
  const result = await readNurseRequest(homecare, bookingId, priorityId, controller.signal);
  assert.equal(result, priority);
  assert.deepEqual(calls, [{ method: "priorityRequest", id: priorityId, signal: controller.signal }]);
});

test("mismatched priority booking is rejected without revealing it or retrying the private draft", async () => {
  const calls = [];
  const homecare = {
    priorityRequest: async () => ({ ...priority, bookingId: "ffbeb937-c80c-4644-bb19-a3c0ee634e80" }),
    booking: async () => { calls.push("booking"); return booking; },
  };
  await assert.rejects(readNurseRequest(homecare, bookingId, priorityId, new AbortController().signal), /pengajuan lain/);
  assert.deepEqual(calls, []);
});

test("ordinary request read remains scoped to the booking endpoint with the same abort signal", async () => {
  const controller = new AbortController();
  const calls = [];
  const result = await readNurseRequest({
    priorityRequest: async () => { throw new Error("Must not be called"); },
    booking: async (id, signal) => { calls.push({ id, signal }); return booking; },
  }, bookingId, null, controller.signal);
  assert.equal(result, booking);
  assert.deepEqual(calls, [{ id: bookingId, signal: controller.signal }]);
});

test("private-draft priority view exposes minimal identity and manual review only, never intake or automatic booking authority", async () => {
  const controller = await nurseController();
  const workspace = getNurseWorkspace(controller);
  await workspace.profile.load(async () => ({ role: "nurse", id: nurseId, accountId, displayName: "Perawat Terpilih", staffCode: "N01", discipline: "nurse", email: "nurse@example.invalid", phone: null, displayTimeZone: "Asia/Jakarta", version: 0 }));
  const html = renderToStaticMarkup(createElement(SessionProvider, { controller }, createElement(NurseWorkspaceProvider, null, createElement(NursePriorityRequestContent, { request: priority, fallbackBookingId: bookingId }))));
  assert.match(html, /Identitas Minimum/);
  assert.match(html, /Kunjungan perlu dilakukan di luar jadwal\./);
  assert.match(html, /Konfirmasi tersedia untuk interval ini/);
  assert.ok(html.includes("Saya benar-benar tersedia untuk interval persis di atas"));
  assert.match(html, /Alasan tinjauan \(wajib\)/);
  assert.match(html, /Simpan tinjauan ketersediaan versi 0/);
  assert.match(html, /pasien tetap mengirim pengajuan dan Anda harus menerimanya secara terpisah/);
  assert.doesNotMatch(html, /Terima pengajuan|Batalkan kunjungan|Ubah jadwal|Panduan perawatan|Screening dan anamnesis|Pasien Privat|Alamat Privat|Telepon darurat|081111111111/);
});

test("request rows retain the original six-column table and honest unavailable doctor slot", () => {
  const html = render(NurseBookingRows, { bookings: [booking] });
  assert.match(html, /homecare-table-wrap/);
  assert.match(html, /hc-col-patient/);
  assert.match(html, /hc-col-doctor/);
  assert.match(html, /<th scope="col">Dokter<\/th>/);
  assert.match(html, /Tidak tersedia/);
  assert.match(html, /request-status-pending/);
  assert.match(html, new RegExp(`/pengajuan-homecare/${bookingId}`));
  assert.equal((html.match(/<th scope="col">/g) ?? []).length, 6);
});

test("screening restores original field groups without inventing missing measurements", () => {
  const html = render(NurseBookingSnapshot, { booking });
  for (const className of ["identity-fields", "screening-complaint", "screening-vitals", "screening-history"]) {
    assert.match(html, new RegExp(`class="${className}"`));
  }
  assert.match(html, /Keluar RS<\/dt><dd>Belum dicatat/);
  assert.match(html, /Suhu tubuh<\/dt><dd>Belum dicatat/);
  assert.match(html, /Detak jantung<\/dt><dd>Belum dicatat/);
  assert.match(html, /Perempuan/);
  assert.match(html, /Kontak darurat/);
  assert.doesNotMatch(html, /36[.,]5|120\/80|risiko tinggi/i);
});

test("screening uses only the reported vital measurement types and units", () => {
  const html = render(NurseBookingSnapshot, { booking: { ...booking, intake: { ...intake, observations: [
    { type: "temperature_c", value: 38.2, unit: "c", observedAt: time },
    { type: "heart_rate_bpm", value: 93, unit: "bpm", observedAt: time },
    { type: "bp_systolic_mmhg", value: 117, unit: "mmhg", observedAt: time },
  ] } } });
  assert.match(html, /Suhu tubuh<\/dt><dd>38\.2 c/);
  assert.match(html, /Detak jantung<\/dt><dd>93 bpm/);
  assert.match(html, /Sistolik: 117 mmhg/);
  assert.match(html, /Diastolik: Belum dicatat/);
});

test("schedule restores grouped cards and excludes unaccepted or visitless bookings", () => {
  const startsAt = new Date(Date.now() + 2 * 86400000).toISOString();
  const accepted = { ...booking, status: "accepted", visitId: priorityId, startsAt };
  const html = render(NurseScheduleRows, { bookings: [
    { ...booking, profileSnapshot: { ...profileSnapshot, fullName: "Pengajuan Belum Diterima" } },
    { ...accepted, id: accountId, status: "cancelled", profileSnapshot: { ...profileSnapshot, fullName: "Kunjungan Dibatalkan" } },
    { ...accepted, id: nurseId, visitId: null, profileSnapshot: { ...profileSnapshot, fullName: "Tanpa Kunjungan" } },
    accepted,
  ] });
  assert.match(html, /card schedule-group/);
  assert.match(html, /schedule-upcoming-header/);
  assert.match(html, /schedule-page-row/);
  assert.match(html, /schedule-status-scheduled/);
  assert.match(html, /Pasien Privat/);
  assert.match(html, new RegExp(`/pengajuan-homecare/${bookingId}`));
  assert.doesNotMatch(html, /Pengajuan Belum Diterima|Kunjungan Dibatalkan|Tanpa Kunjungan|schedule-status-done/);
});

test("schedule loads accepted bookings across opaque pages without a 31-day horizon or schedule requests", async () => {
  const at = days => new Date(Date.now() + days * 86400000).toISOString();
  const near = { ...booking, status: "accepted", visitId: priorityId, startsAt: at(2), endsAt: at(2 + 1 / 24) };
  const distant = {
    ...near, id: accountId, visitId: patientId, startsAt: at(90), endsAt: at(90 + 1 / 24),
    profileSnapshot: { ...profileSnapshot, fullName: "Pasien Kunjungan Jauh" },
  };
  const cursor = "accepted:next/+opaque==";
  const calls = [];
  const controller = new AbortController();
  const api = createHomecareApi(createApiClient({ fetch: async (input, init) => {
    const url = new URL(input, "https://forcare.invalid");
    calls.push(url.pathname);
    assert.equal(init.signal, controller.signal);
    assert.equal(url.pathname, "/api/v1/bookings");
    assert.equal(url.searchParams.get("status"), "accepted");
    assert.equal(url.searchParams.has("from"), false);
    assert.equal(url.searchParams.has("to"), false);
    const next = url.searchParams.get("cursor");
    assert.ok(next === null || next === cursor, "cursor must survive URL encoding unchanged");
    return new Response(JSON.stringify({
      data: next === null
        ? { items: [near], page: { nextCursor: cursor, hasMore: true } }
        : { items: [distant], page: { nextCursor: null, hasMore: false } },
      requestId: priorityId,
    }));
  } }), nurseId);
  const first = await readNurseVisitSchedule(api, controller.signal);
  const firstHtml = render(NurseScheduleRows, { bookings: first.items, tab: "visits" });
  assert.match(firstHtml, /Pasien Privat/);
  assert.doesNotMatch(firstHtml, /Pasien Kunjungan Jauh/);
  assert.equal(first.page.hasMore, true);
  const second = await readNurseVisitSchedule(api, controller.signal, first.page.nextCursor);
  const loaded = [...first.items, ...second.items];
  assert.ok(Date.parse(second.items[0].startsAt) - Date.now() > 31 * 86400000);
  for (const tab of ["visits", "all"]) {
    const html = render(NurseScheduleRows, { bookings: loaded, tab });
    assert.match(html, /Pasien Privat/);
    assert.match(html, /Pasien Kunjungan Jauh/);
    assert.match(html, new RegExp(`/pengajuan-homecare/${accountId}`));
    assert.doesNotMatch(html, /schedule-status-done/);
  }
  assert.equal(second.page.hasMore, false);
  assert.equal(second.page.nextCursor, null);
  assert.deepEqual(calls, ["/api/v1/bookings", "/api/v1/bookings"]);
});

test("elapsed accepted visits stay scheduled, never become fictional completed visits", () => {
  const startsAt = new Date(Date.now() - 2 * 86400000).toISOString();
  const accepted = { ...booking, status: "accepted", visitId: priorityId, startsAt };
  const all = render(NurseScheduleRows, { bookings: [accepted], tab: "all" });
  assert.match(all, /schedule-past-header/);
  assert.match(all, /schedule-status-scheduled/);
  assert.doesNotMatch(all, /schedule-status-done/);
  const upcoming = render(NurseScheduleRows, { bookings: [accepted], tab: "visits" });
  assert.match(upcoming, /Belum ada kunjungan/);
  assert.doesNotMatch(upcoming, /schedule-page-row/);
  const done = render(NurseScheduleRows, { bookings: [accepted], tab: "done" });
  assert.match(done, /Riwayat kunjungan selesai belum tersedia/);
  assert.doesNotMatch(done, /schedule-page-row|Pasien Privat/);
});

test("reschedule revalidates booking and slot or approved exception starts after time passes", () => {
  const now = Date.parse(time);
  const accepted = { ...booking, status: "accepted", startsAt: new Date(now + 120_000).toISOString() };
  for (const slotId of [priorityId, null]) {
    const target = { slotId, startsAt: new Date(now + 60_000).toISOString(), endsAt: later };
    assert.equal(isNurseRescheduleTimely(accepted, target, now), true);
    assert.equal(isNurseRescheduleTimely(accepted, target, now + 60_000), false);
    assert.equal(isNurseRescheduleTimely(accepted, target, now + 90_000), false);
    const futureTarget = { ...target, startsAt: new Date(now + 180_000).toISOString() };
    assert.equal(isNurseRescheduleTimely(accepted, futureTarget, now + 120_000), false);
    assert.equal(isNurseRescheduleTimely({ ...accepted, status: "submitted" }, target, now), false);
  }
});
