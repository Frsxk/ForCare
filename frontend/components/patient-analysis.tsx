"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { AlertCircle, Check, ChevronDown, ChevronUp, FilePenLine, Info, RefreshCw, Send, Sparkles } from "lucide-react";
import { useNurseWorkspace, useNurseRead, useResource } from "@/components/nurse-workspace-provider";
import { ReadPanel } from "@/components/nurse-workspace-pages";
import { AnalysisWriteController, prepareAnalysisGeneration, prepareAnalysisPublication, prepareAnalysisReview, prepareAnalysisRevision, type Analysis, type AnalysisClaimInput, type AnalysisEvidence, type AnalysisJob, type AnalysisReview } from "@/lib/api/analysis";
import "./patient-analysis.css";

type AnalysisApi = ReturnType<typeof useNurseWorkspace>["api"];
const statusLabels: Record<Analysis["status"], string> = { draft: "Draf · perlu ditinjau", in_review: "Menunggu tinjauan perawat", approved: "Disetujui perawat", rejected: "Ditolak", published: "Dipublikasikan" };
const claimLabels: Record<AnalysisClaimInput["claimType"], string> = { observation_summary: "Ringkasan observasi", concern: "Hal yang perlu diperhatikan", suggestion: "Saran untuk ditinjau", care_note: "Catatan perawatan" };
const reviewLabels: Record<AnalysisReview["decision"], string> = { approve: "Disetujui", reject: "Ditolak", changes_requested: "Perlu perubahan" };
const jobErrors: Record<NonNullable<AnalysisJob["errorCode"]>, string> = {
  INSUFFICIENT_EVIDENCE: "Data yang tersedia belum cukup untuk menyusun draf.", INVALID_MODEL_OUTPUT: "Hasil model tidak lolos pemeriksaan. Tidak ada draf yang disimpan dari hasil tersebut.",
  PROVIDER_TIMEOUT: "Layanan penyusun draf melewati batas waktu.", PROVIDER_RATE_LIMITED: "Kapasitas layanan penyusun draf sedang terbatas.", PROVIDER_AUTH_FAILED: "Layanan penyusun draf belum dapat diautentikasi.",
  PROVIDER_SAFETY_BLOCKED: "Layanan penyusun draf menolak permintaan berdasarkan kebijakan keselamatan.", PROVIDER_UNAVAILABLE: "Layanan penyusun draf belum tersedia.", STALE_CONTEXT: "Data sumber telah berubah. Muat ulang sebelum membuat draf baru.",
  SCOPE_REVOKED: "Akses penugasan telah berubah.", ATTEMPTS_EXHAUSTED: "Batas percobaan penyusunan telah tercapai.", INTERNAL_ERROR: "Draf belum dapat diproses.",
};

function Evidence({ evidence }: { evidence: AnalysisEvidence }) {
  const references = [
    evidence.observationId && `Observasi: ${evidence.observationId}`,
    evidence.orderId && `Instruksi: ${evidence.orderId}`,
    evidence.sourceDocumentId && `Sumber klinis: ${evidence.sourceDocumentId} · revisi ${evidence.sourceVersion}`,
    evidence.knowledgeChunkId && `Pengetahuan terverifikasi: ${evidence.knowledgeChunkId}`,
  ].filter(Boolean);
  return <li><span>Check-in {evidence.checkInId}</span>{references.map(reference => <span key={reference}>{reference}</span>)}</li>;
}
function WriteFeedback({ write, onRetry, onReconcile }: { write: AnalysisWriteController; onRetry: () => void; onReconcile: () => void }) {
  const state = useSyncExternalStore(write.subscribe, write.getSnapshot, write.getSnapshot);
  if (state.status === "idle") return null;
  return <div className={`analysis-write-feedback is-${state.status}`} role={state.status === "sending" ? "status" : "alert"}>
    {state.status === "sending" ? <p>Mengirim tindakan. Jangan tutup halaman ini.</p> : state.status === "uncertain" ? <>
      <p>Hasil tindakan belum dapat dipastikan. Jangan membuat tindakan pengganti. Memuat ulang tampilan tidak memastikan hasil tulis.</p>{state.error && <p>{state.error.message}</p>}
      <div className="analysis-feedback-actions"><button type="button" className="button button-outline" onClick={onReconcile}>Muat ulang tampilan</button><button type="button" className="button button-outline" onClick={onRetry}>Kirim ulang permintaan yang sama</button></div>
    </> : <><p>{state.error?.message ?? "Tindakan belum berhasil."}</p>{state.error?.requestId && <small>Referensi permintaan: {state.error.requestId}</small>}<button type="button" className="text-button" onClick={onRetry}>Coba lagi</button></>}
  </div>;
}

export function AnalysisReviewView({ analysis, checkInId, onChanged, onRevised, retryRef, write, api }: { analysis: Analysis; checkInId: string; onChanged: () => Promise<Analysis | undefined>; onRevised?: (id: string) => Promise<unknown>; retryRef?: { current: (() => void) | null }; write: AnalysisWriteController; api: AnalysisApi }) {
  const [claims, setClaims] = useState<AnalysisClaimInput[]>(analysis.claims.map(({ text, claimType, evidence }) => ({ text, claimType, evidence })));
  const [editing, setEditing] = useState(false);
  const [decision, setDecision] = useState<AnalysisReview["decision"]>("approve");
  const [comment, setComment] = useState("");
  const [confirm, setConfirm] = useState<"approve" | "publish" | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const writeState = useSyncExternalStore(write.subscribe, write.getSnapshot, write.getSnapshot);
  const busy = writeState.status === "sending";
  const locked = busy || writeState.status === "uncertain";
  const editable = (analysis.status === "draft" || analysis.status === "in_review") && analysis.checkInId === checkInId;
  const approval = analysis.reviews.find(review => review.decision === "approve");
  function resetConfirmation() { setConfirm(null); setNotice(null); }
  function beginEdit() {
    setClaims(analysis.claims.map(({ text, claimType, evidence }) => ({ text, claimType, evidence })));
    setFormError(null); setEditing(true); resetConfirmation();
  }
  function updateClaim(index: number, patch: Partial<AnalysisClaimInput>) {
    setClaims(previous => previous.map((claim, position) => position === index ? { ...claim, ...patch } : claim)); setFormError(null); resetConfirmation();
  }
  async function saveRevision(event: FormEvent) {
    event.preventDefault();
    if (claims.some(claim => !claim.text.trim())) { setFormError("Setiap butir harus berisi teks. Hapus butir yang tidak diperlukan."); return; }
    const intent = prepareAnalysisRevision(analysis, claims);
    const result = await write.send("revise", intent, signal => api.analysisRevision(analysis.patientId, analysis.id, intent, signal));
    if (!result) return;
    setEditing(false); setNotice(`Revisi ${result.revisionNumber} tersimpan sebagai draf baru. Tinjauan sebelumnya tidak dibawa ke revisi ini.`);
    if (onRevised) await onRevised(result.id); else await onChanged();
  }
  async function review(event?: FormEvent) {
    event?.preventDefault();
    if (decision !== "approve" && !comment.trim()) { setFormError("Tulis komentar untuk meminta perubahan atau menolak draf."); return; }
    if (decision === "approve" && confirm !== "approve") { setConfirm("approve"); return; }
    const intent = prepareAnalysisReview(analysis, decision, decision === "approve" && !comment.trim() ? null : comment.trim());
    const result = await write.send("review", intent, signal => api.analysisReview(analysis.patientId, analysis.id, intent, signal));
    if (!result) return;
    setConfirm(null); setComment(""); setNotice(`Tinjauan ${reviewLabels[decision].toLowerCase()} tersimpan. Status terbaru sedang diperiksa.`);
    await onChanged();
  }
  async function publish() {
    if (!approval || confirm !== "publish") { setConfirm("publish"); return; }
    const intent = prepareAnalysisPublication(analysis, approval.id);
    const result = await write.send("publish", intent, signal => api.analysisPublication(analysis.patientId, analysis.id, intent, signal));
    if (!result) return;
    setConfirm(null); setNotice("Publikasi tersimpan. Status terbaru sedang diperiksa."); await onChanged();
  }
  function retry() {
    const { intent, operation } = write.getSnapshot();
    if (!intent || !operation || operation === "generate") return;
    const action = operation === "revise" ? (signal: AbortSignal) => api.analysisRevision(analysis.patientId, analysis.id, intent, signal)
      : operation === "review" ? (signal: AbortSignal) => api.analysisReview(analysis.patientId, analysis.id, intent, signal)
      : operation === "publish" ? (signal: AbortSignal) => api.analysisPublication(analysis.patientId, analysis.id, intent, signal) : null;
    if (action) void write.send<unknown>(operation, intent, action).then(async result => {
      if (!result) return;
      setConfirm(null);
      if (operation === "revise" && typeof result === "object" && result !== null && "id" in result && typeof result.id === "string" && onRevised) await onRevised(result.id); else await onChanged();
    });
  }
  useEffect(() => {
    if (retryRef) retryRef.current = retry;
    return () => { if (retryRef) retryRef.current = null; };
  });
  return <section className="patient-analysis" aria-label={`Analisis revisi ${analysis.revisionNumber}`}>
    <div className="analysis-status-row"><span className={`analysis-status is-${analysis.status}`}>{statusLabels[analysis.status]}</span><span>Revisi {analysis.revisionNumber} · versi workflow {analysis.version}</span></div>
    <p className="analysis-bound-checkin">Dibuat dari check-in <code>{analysis.checkInId}</code>. ID analisis: <code>{analysis.id}</code></p>
    <div className="analysis-safety-note"><Info size={18} aria-hidden="true" /><p>Ini adalah draf AI untuk membantu perawat, bukan diagnosis, skor risiko atau keputusan klinis. Periksa setiap pernyataan dan sumbernya sebelum menyetujui. Publikasi hanya dilakukan oleh perawat.</p></div>
    {notice && <p className="analysis-notice" role="status">{notice}</p>}
    {formError && <p className="patient-form-error" role="alert">{formError}</p>}
    <div className="analysis-claims">{analysis.claims.map((claim, index) => <article className="analysis-claim" key={claim.claimId}>
      <div className="analysis-claim-heading"><h3>{claimLabels[claim.claimType]}</h3><span>Butir {index + 1}</span></div>
      {editing && editable ? <div className="analysis-claim-fields">
        <label>Jenis pernyataan<select value={claims[index]?.claimType} onChange={event => updateClaim(index, { claimType: event.target.value as AnalysisClaimInput["claimType"] })}>{Object.entries(claimLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        <label>Teks pernyataan<textarea required maxLength={4000} value={claims[index]?.text ?? ""} onChange={event => updateClaim(index, { text: event.target.value })} /></label>
      </div> : <p className="analysis-claim-text">{claim.text}</p>}
      <details className="analysis-evidence"><summary>Bukti terkait ({claim.evidence.length})<ChevronDown size={15} aria-hidden="true" /></summary><p>Referensi sumber, bukan teks sumber yang disalin otomatis.</p><ul>{claim.evidence.map((item, evidenceIndex) => <Evidence evidence={item} key={evidenceIndex} />)}</ul></details>
      {editing && editable && <p className="analysis-evidence-lock">Rujukan bukti tetap dipertahankan dan tidak dapat diubah pada layar ini.</p>}
    </article>)}</div>
    {editing && editable && <div className="analysis-edit-controls"><div><button type="button" className="text-button" disabled={claims.length <= 1} onClick={() => setClaims(previous => previous.length > 1 ? previous.slice(0, -1) : previous)}>Hapus butir terakhir</button><button type="button" className="text-button" disabled={claims.length >= 50} onClick={() => {
      const evidence = claims.flatMap(claim => claim.evidence);
      if (!evidence.length) { setFormError("Tidak ada bukti yang dapat dipertahankan untuk butir baru."); return; }
      setClaims(previous => [...previous, { text: "", claimType: "care_note", evidence }]);
    }}>Tambah butir dengan bukti yang sama</button></div><form onSubmit={saveRevision}><button type="button" className="button button-outline" disabled={busy} onClick={() => { setEditing(false); setFormError(null); }}>Batal</button><button type="submit" className="button button-primary" disabled={busy}><FilePenLine size={16} aria-hidden="true" />Simpan sebagai revisi baru</button></form></div>}
    {!editing && editable && <button type="button" className="button button-outline" disabled={locked} onClick={beginEdit}><FilePenLine size={16} aria-hidden="true" />Edit draf</button>}
    {analysis.reviews.length > 0 && <section className="analysis-review-history" aria-labelledby={`reviews-${analysis.id}`}><h3 id={`reviews-${analysis.id}`}>Riwayat tinjauan revisi ini</h3>{analysis.reviews.map(review => <article key={review.id}><strong>{reviewLabels[review.decision]}</strong><p>{review.comment ?? "Tanpa komentar tambahan."}</p><small>ID tinjauan {review.id} · {review.decidedAt} (UTC)</small></article>)}</section>}
    {analysis.status === "in_review" && analysis.checkInId === checkInId && <form className="analysis-review-form" onSubmit={review}>
      <h3>Tinjauan perawat</h3><label>Keputusan<select value={decision} onChange={event => { setDecision(event.target.value as AnalysisReview["decision"]); setFormError(null); resetConfirmation(); }}><option value="approve">Setujui revisi ini</option><option value="changes_requested">Minta perubahan</option><option value="reject">Tolak revisi ini</option></select></label>
      <label>Komentar {decision === "approve" ? "(opsional)" : "(wajib)"}<textarea maxLength={4000} value={comment} onChange={event => { setComment(event.target.value); setFormError(null); resetConfirmation(); }} /></label>
      {confirm === "approve" ? <div className="analysis-confirmation" role="alert"><p>Saya telah memeriksa isi dan bukti revisi {analysis.revisionNumber}. Persetujuan ini bukan publikasi.</p><button type="button" className="button button-outline" disabled={busy} onClick={() => setConfirm(null)}>Batal</button><button type="submit" className="button button-primary" disabled={locked}><Check size={16} aria-hidden="true" />Konfirmasi persetujuan</button></div> : <button type="submit" className="button button-primary" disabled={locked}><Check size={16} aria-hidden="true" />{decision === "approve" ? "Tinjau dan setujui" : "Simpan keputusan tinjauan"}</button>}
    </form>}
    {analysis.status === "approved" && approval && <section className="analysis-publish-section"><h3>Siap untuk publikasi</h3><p>Persetujuan belum membuat analisis terlihat oleh pasien. Publikasikan hanya revisi {analysis.revisionNumber} yang telah disetujui.</p>{confirm === "publish" ? <div className="analysis-confirmation" role="alert"><p>Publikasikan revisi {analysis.revisionNumber} kepada pasien? Tindakan ini tidak dapat dibatalkan dari layar ini.</p><button className="button button-outline" disabled={busy} onClick={() => setConfirm(null)}>Batal</button><button className="button button-primary" disabled={locked} onClick={publish}><Send size={16} aria-hidden="true" />Ya, publikasikan revisi ini</button></div> : <button className="button button-primary" disabled={locked} onClick={publish}><Send size={16} aria-hidden="true" />Publikasikan ke pasien</button>}</section>}
    {analysis.publication && <p className="analysis-publication">Dipublikasikan pada {analysis.publication.publishedAt} (UTC) · ID publikasi {analysis.publication.id}</p>}
    {!retryRef && <WriteFeedback write={write} onRetry={retry} onReconcile={() => void onChanged()} />}
  </section>;
}

function JobStatus({ patientId, job, onSaved }: { patientId: string; job: AnalysisJob; onSaved: (analysisId: string, savedJob: AnalysisJob) => Promise<void> }) {
  const { api, scope } = useNurseWorkspace();
  const [current, setCurrent] = useState(job);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [pollLimit, setPollLimit] = useState(false);
  const savedRef = useRef(false), inFlight = useRef(false), attempts = useRef(0);
  const request = useRef<AbortController | null>(null);
  const savedCallback = useRef(onSaved);
  useEffect(() => { savedCallback.current = onSaved; }, [onSaved]);
  const check = useCallback(async () => {
    const abort = request.current;
    if (!abort || abort.signal.aborted || inFlight.current || savedRef.current || !scope.isCurrent()) return;
    inFlight.current = true; setChecking(true); setError(null);
    try {
      const next = await api.analysisJob(patientId, job.checkInId, job.id, abort.signal);
      if (abort.signal.aborted || !scope.isCurrent()) return;
      setCurrent(next);
      if (next.analysisId) {
        savedRef.current = true;
        await savedCallback.current(next.analysisId, next);
      } else if (next.status === "failed") savedRef.current = true;
    } catch (failure) {
      if (!abort.signal.aborted && scope.isCurrent()) setError(failure instanceof Error ? failure.message : "Status draf belum dapat diperiksa.");
    } finally {
      inFlight.current = false;
      if (!abort.signal.aborted && scope.isCurrent()) setChecking(false);
    }
  }, [api, job.checkInId, job.id, patientId, scope]);
  useEffect(() => {
    const abort = new AbortController(); request.current = abort;
    if (job.status !== "queued" && job.status !== "running") return () => abort.abort();
    const timer = globalThis.setInterval(() => {
      if (savedRef.current || !scope.isCurrent()) { globalThis.clearInterval(timer); return; }
      if (inFlight.current) return;
      if (attempts.current >= 40) { globalThis.clearInterval(timer); setPollLimit(true); return; }
      attempts.current++; void check();
    }, 2500);
    return () => { abort.abort(); globalThis.clearInterval(timer); };
  }, [check, job.status, scope]);
  return <div className="analysis-job" role="status"><h3>{current.status === "failed" ? "Draf belum berhasil disusun" : current.analysisId ? "Draf tersimpan" : "AI sedang menyusun draf"}</h3><p>{current.status === "queued" ? "Permintaan telah masuk antrean. Halaman ini memeriksa status secara berkala." : current.status === "running" ? "Draf sedang diproses. Jangan mengirim permintaan baru." : current.status === "failed" ? jobErrors[current.errorCode ?? "INTERNAL_ERROR"] : "Draf telah tersimpan dan siap ditinjau perawat."}</p>{pollLimit && <p>Pemeriksaan otomatis dihentikan setelah 40 kali. Gunakan Periksa status untuk melanjutkan secara manual.</p>}{error && <p role="alert">{error}</p>}<button type="button" className="button button-outline" disabled={checking || current.analysisId !== null} onClick={() => void check()}><RefreshCw size={15} aria-hidden="true" />Periksa status</button></div>;
}

export function PatientAnalysisPanel({ patientId, checkInId, checkInDate }: { patientId: string; checkInId: string | null; checkInDate: string | null }) {
  const { api, scope } = useNurseWorkspace();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const retryRef = useRef<(() => void) | null>(null);
  const retry = useCallback(() => retryRef.current?.(), []);
  const [write] = useState(() => new AnalysisWriteController(scope.isCurrent));
  const writeState = useSyncExternalStore(write.subscribe, write.getSnapshot, write.getSnapshot);
  const readLoader = useCallback((signal: AbortSignal) => api.analyses(patientId, null, signal), [api, patientId]);
  const list = useNurseRead(readLoader);
  const [job, setJob] = useState<AnalysisJob | null>(null);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => () => write.clear(), [write]);
  const [detailResource] = useState(() => scope.resource<Analysis>());
  const detailState = useResource(detailResource);
  const items = list.state.status === "ready" ? list.state.data.items.filter(item => item.checkInId === checkInId) : [];
  const active = items.find(item => item.id === selectedId) ?? items[0];
  useEffect(() => {
    if (!active) { detailResource.clear(); return; }
    void detailResource.load(signal => api.analysis(patientId, active.id, signal));
    return () => detailResource.clear();
  }, [active, api, detailResource, patientId]);
  async function reloadList(targetId?: string) {
    if (targetId) setSelectedId(targetId);
    const result = await list.reload();
    return result?.items.find(item => item.id === targetId);
  }
  const onChanged = useCallback(async () => {
    await list.reload();
    if (!active) return;
    return detailResource.load(signal => api.analysis(patientId, active.id, signal));
  }, [api, patientId, active, detailResource, list]);
  async function generate() {
    if (!checkInId || job || write.getSnapshot().status !== "idle") return;
    const intent = prepareAnalysisGeneration(patientId, checkInId, "id");
    const result = await write.send("generate", intent, signal => api.analysisGeneration(patientId, checkInId, intent, signal));
    if (result) setJob(result);
  }

  return <section className="card live-card analysis-workflow-card" aria-labelledby="analysis-title">
    <div className="analysis-card-heading"><div><span className="analysis-eyebrow"><Sparkles size={16} aria-hidden="true" />Bantuan dokumentasi AI</span><h2 id="analysis-title">Draf analisis kondisi</h2></div>{list.state.status === "ready" && <button type="button" className="analysis-toggle" aria-expanded={expanded} aria-controls="analysis-content" onClick={() => setExpanded(!expanded)}>{expanded ? "Tutup" : "Buka"}{expanded ? <ChevronUp size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}</button>}</div>
    <p className="analysis-intro">Susun draf dari check-in yang sudah diserahkan. Perawat meninjau, mengedit, menyetujui dan memublikasikan secara terpisah.</p>
    <ReadPanel state={list.state} reload={list.reload}>{() => <div id="analysis-content" hidden={!expanded} className="analysis-content">
      {checkInId ? <><div className="analysis-checkin-source"><span>Check-in terpilih</span><strong>{checkInDate ?? "Tanggal belum dicatat"}</strong><code>{checkInId}</code></div>
        {!job && <button type="button" className="button button-primary" disabled={writeState.status !== "idle" || (!!active && active.status !== "published" && active.status !== "rejected")} onClick={() => void generate()}><Sparkles size={16} aria-hidden="true" />Buat draf AI</button>}
        {job && <JobStatus patientId={patientId} job={job} onSaved={async (id, savedJob) => { setJob(savedJob); await reloadList(id); }} />}
        {items.length > 1 && <label className="analysis-version-picker">Pilih revisi<select value={active?.id} disabled={writeState.status === "uncertain" || writeState.status === "sending"} onChange={event => setSelectedId(event.target.value)}>{items.map(item => <option value={item.id} key={item.id}>Revisi {item.revisionNumber} · {statusLabels[item.status]}</option>)}</select></label>}
        {active && <ReadPanel state={detailState} reload={onChanged}>{current => <AnalysisReviewView key={current.id} analysis={current} checkInId={checkInId} onChanged={onChanged} onRevised={reloadList} retryRef={retryRef} write={write} api={api} />}</ReadPanel>}
        {!active && !job && <p className="analysis-empty"><AlertCircle size={17} aria-hidden="true" />Belum ada draf untuk check-in ini. Draf baru akan muncul setelah berhasil disimpan oleh server.</p>}
      </> : <p className="analysis-empty">Belum ada check-in yang diserahkan. Draf tidak dapat dibuat tanpa data check-in pasien.</p>}
      {list.state.status === "ready" && list.state.data.page.hasMore && <p>Menampilkan hingga 100 analisis terbaru. Gunakan riwayat server untuk analisis yang lebih lama.</p>}
      {writeState.operation === "generate" ? <WriteFeedback write={write} onRetry={retry} onReconcile={() => { void list.reload(); }} /> : <WriteFeedback write={write} onRetry={retry} onReconcile={() => { void list.reload(); }} />}
    </div>}</ReadPanel>
  </section>;
}
