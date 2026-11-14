import { test } from "bun:test";
import assert from "node:assert/strict";
import { formatPatientDate, formatPatientTime, formatPatientDateTime } from "../lib/patient-homecare-display";

test("patient schedules use the session timezone across midnight instead of the host calendar", () => {
  const timestamp = "2026-11-15T17:05:00.000Z";
  assert.equal(formatPatientDate(timestamp, "Asia/Jakarta"), "Sen, 16 Nov 2026");
  assert.equal(formatPatientTime(timestamp, "Asia/Jakarta"), "00.05");
  assert.equal(formatPatientDateTime(timestamp, "Asia/Jakarta"), "Sen, 16 Nov 2026 · 00.05 WIB");
  assert.equal(formatPatientDateTime(timestamp, "Asia/Makassar"), "Sen, 16 Nov 2026 · 01.05 WITA");
  assert.equal(formatPatientDateTime(timestamp, "UTC"), "Min, 15 Nov 2026 · 17.05 UTC");
});
