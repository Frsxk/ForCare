-- 0008 reviews (T12). Domain approval, graph reconciliation and publication
-- are distinct. No client-supplied actor identity or model approval text.

CREATE TABLE public.analysis_review_gates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id uuid NOT NULL,
  analysis_revision_number integer NOT NULL CHECK (analysis_revision_number >= 1),
  thread_id text NOT NULL UNIQUE CHECK (btrim(thread_id) <> '' AND length(thread_id) <= 200),
  checkpoint_id text NOT NULL CHECK (btrim(checkpoint_id) <> '' AND length(checkpoint_id) <= 200),
  checkpoint_namespace text NOT NULL CHECK (length(checkpoint_namespace) <= 200),
  state text NOT NULL DEFAULT 'waiting' CHECK (state IN ('waiting', 'decided', 'reconciled')),
  review_id uuid UNIQUE,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  reconciled_at timestamptz(3),
  FOREIGN KEY (analysis_id, analysis_revision_number) REFERENCES public.analyses (id, revision_number) ON DELETE RESTRICT,
  UNIQUE (analysis_id, analysis_revision_number),
  UNIQUE (id, analysis_id, analysis_revision_number),
  CHECK ((state = 'waiting' AND review_id IS NULL AND reconciled_at IS NULL)
    OR (state = 'decided' AND review_id IS NOT NULL AND reconciled_at IS NULL)
    OR (state = 'reconciled' AND review_id IS NOT NULL AND reconciled_at IS NOT NULL))
);

CREATE TABLE public.analysis_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id uuid NOT NULL,
  analysis_revision_number integer NOT NULL CHECK (analysis_revision_number >= 1),
  reviewer_staff_id uuid NOT NULL REFERENCES public.staff (id) ON DELETE RESTRICT,
  decision text NOT NULL CHECK (decision IN ('approve', 'reject', 'changes_requested')),
  comment text CHECK (comment IS NULL OR (btrim(comment) <> '' AND length(comment) <= 4000)),
  decided_at timestamptz(3) NOT NULL DEFAULT now(),
  gate_id uuid NOT NULL UNIQUE,
  expected_version integer NOT NULL CHECK (expected_version >= 0),
  version integer GENERATED ALWAYS AS (expected_version + 1) STORED,
  FOREIGN KEY (analysis_id, analysis_revision_number) REFERENCES public.analyses (id, revision_number) ON DELETE RESTRICT,
  FOREIGN KEY (gate_id, analysis_id, analysis_revision_number) REFERENCES public.analysis_review_gates (id, analysis_id, analysis_revision_number) ON DELETE RESTRICT,
  UNIQUE (analysis_id, analysis_revision_number, reviewer_staff_id),
  UNIQUE (id, analysis_id, analysis_revision_number, decision),
  UNIQUE (id, analysis_id, analysis_revision_number),
  CHECK (decision = 'approve' OR comment IS NOT NULL)
);
ALTER TABLE public.analysis_review_gates ADD CONSTRAINT analysis_review_gates_review_fkey
  FOREIGN KEY (review_id, analysis_id, analysis_revision_number)
  REFERENCES public.analysis_reviews (id, analysis_id, analysis_revision_number) ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.analysis_publications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id uuid NOT NULL,
  analysis_revision_number integer NOT NULL CHECK (analysis_revision_number >= 1),
  review_id uuid NOT NULL,
  review_decision text NOT NULL CHECK (review_decision = 'approve'),
  published_by uuid NOT NULL REFERENCES public.staff (id) ON DELETE RESTRICT,
  published_at timestamptz(3) NOT NULL DEFAULT now(),
  expected_version integer NOT NULL CHECK (expected_version >= 0),
  UNIQUE (analysis_id, analysis_revision_number),
  FOREIGN KEY (analysis_id, analysis_revision_number) REFERENCES public.analyses (id, revision_number) ON DELETE RESTRICT,
  FOREIGN KEY (review_id, analysis_id, analysis_revision_number, review_decision) REFERENCES public.analysis_reviews (id, analysis_id, analysis_revision_number, decision) ON DELETE RESTRICT
);

CREATE FUNCTION public.forcare_analysis_assert_current_revision(p_analysis uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE snapshot public.analyses%ROWTYPE;
BEGIN
  PERFORM public.forcare_analysis_require_read_committed();
  SELECT * INTO snapshot FROM public.analyses WHERE id = p_analysis;
  IF NOT FOUND THEN RAISE EXCEPTION 'analysis snapshot not found' USING ERRCODE = '23503'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('analysis-lineage:' || snapshot.lineage_id::text, 0));
  IF EXISTS (SELECT 1 FROM public.analyses later WHERE later.lineage_id = snapshot.lineage_id AND later.revision_number > snapshot.revision_number) THEN
    RAISE EXCEPTION 'only latest analysis revision can advance workflow' USING ERRCODE = '23514'; END IF;
  PERFORM public.forcare_analysis_assert_context(snapshot.patient_id, snapshot.check_in_id, snapshot.input_snapshot);
  -- Knowledge document retirement after generation also invalidates approval
  -- and publication. Lock the same rows whose workflow would retire them.
  PERFORM 1 FROM public.knowledge_documents d JOIN public.knowledge_chunks c ON c.document_id = d.id
    WHERE c.id = ANY(snapshot.retrieved_chunk_ids) ORDER BY d.id FOR SHARE OF d;
  IF EXISTS (SELECT 1 FROM public.knowledge_chunks c JOIN public.knowledge_documents d ON d.id = c.document_id
    WHERE c.id = ANY(snapshot.retrieved_chunk_ids) AND (d.status <> 'approved' OR d.corpus_id <> (snapshot.input_snapshot->>'corpusId')::uuid)) THEN
    RAISE EXCEPTION 'analysis knowledge document is no longer approved' USING ERRCODE = '23514'; END IF;
END;
$$;

CREATE FUNCTION public.forcare_analysis_review_gate_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE snapshot public.analyses%ROWTYPE;
BEGIN
  PERFORM public.forcare_analysis_require_read_committed();
  SELECT * INTO snapshot FROM public.analyses WHERE id = NEW.analysis_id FOR UPDATE;
  IF NOT FOUND OR snapshot.revision_number <> NEW.analysis_revision_number OR snapshot.finalized_at IS NULL THEN
    RAISE EXCEPTION 'review gate requires exact finalized snapshot' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM public.forcare_analysis_assert_current_revision(NEW.analysis_id);
    IF NEW.state <> 'waiting' OR NEW.version <> 0 OR snapshot.status <> 'draft' OR snapshot.version <> 0 THEN
      RAISE EXCEPTION 'new revision requires fresh waiting review gate' USING ERRCODE = '23514'; END IF;
    NEW.created_at := statement_timestamp();
    UPDATE public.analyses SET status = 'in_review', version = version + 1 WHERE id = NEW.analysis_id;
  ELSE
    IF (to_jsonb(NEW) - ARRAY['state','review_id','version','updated_at','reconciled_at'])
      IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state','review_id','version','updated_at','reconciled_at'])
      OR NEW.version <> OLD.version + 1 OR NOT (
        (OLD.state = 'waiting' AND NEW.state = 'decided')
        OR (OLD.state = 'decided' AND NEW.state = 'reconciled')
      ) THEN RAISE EXCEPTION 'invalid review gate transition' USING ERRCODE = '23514'; END IF;
    IF OLD.state = 'decided' AND NEW.review_id IS DISTINCT FROM OLD.review_id THEN
      RAISE EXCEPTION 'review gate decision binding is immutable' USING ERRCODE = '55000'; END IF;
    IF NEW.state = 'reconciled' THEN
      -- Reconciliation is an execution receipt, not an authority grant. The
      -- worker must reauthenticate current primary scope before graph resume.
      IF NOT EXISTS (SELECT 1 FROM public.analysis_reviews WHERE id = NEW.review_id AND gate_id = NEW.id
        AND analysis_id = NEW.analysis_id AND analysis_revision_number = NEW.analysis_revision_number) THEN
        RAISE EXCEPTION 'graph reconciliation requires exact stored decision' USING ERRCODE = '23514'; END IF;
      NEW.reconciled_at := statement_timestamp();
    END IF;
  END IF;
  NEW.updated_at := statement_timestamp();
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.forcare_analysis_review_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  snapshot public.analyses%ROWTYPE;
  gate public.analysis_review_gates%ROWTYPE;
BEGIN
  PERFORM public.forcare_analysis_assert_staff(NEW.reviewer_staff_id);
  PERFORM public.forcare_analysis_assert_current_revision(NEW.analysis_id);
  SELECT * INTO snapshot FROM public.analyses WHERE id = NEW.analysis_id FOR UPDATE;
  SELECT * INTO gate FROM public.analysis_review_gates WHERE id = NEW.gate_id FOR UPDATE;
  IF NOT FOUND OR gate.state <> 'waiting' OR gate.analysis_id <> NEW.analysis_id
    OR gate.analysis_revision_number <> NEW.analysis_revision_number
    OR snapshot.revision_number <> NEW.analysis_revision_number OR snapshot.status <> 'in_review'
    OR snapshot.version <> NEW.expected_version
  THEN RAISE EXCEPTION 'review requires exact waiting gate and workflow version' USING ERRCODE = '23514'; END IF;
  NEW.decided_at := statement_timestamp();
  UPDATE public.analysis_review_gates SET state = 'decided', review_id = NEW.id, version = version + 1 WHERE id = gate.id;
  -- changes_requested never mutates content; the consumed gate cannot reopen.
  -- The next correction must create a new analysis ID/revision/gate.
  UPDATE public.analyses SET status = CASE NEW.decision WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE 'draft' END,
    version = version + 1 WHERE id = snapshot.id;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.forcare_analysis_publication_insert_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  snapshot public.analyses%ROWTYPE;
  review public.analysis_reviews%ROWTYPE;
  gate public.analysis_review_gates%ROWTYPE;
BEGIN
  PERFORM public.forcare_analysis_assert_staff(NEW.published_by);
  PERFORM public.forcare_analysis_assert_current_revision(NEW.analysis_id);
  SELECT * INTO snapshot FROM public.analyses WHERE id = NEW.analysis_id FOR UPDATE;
  SELECT * INTO review FROM public.analysis_reviews WHERE id = NEW.review_id;
  IF NOT FOUND OR review.analysis_id <> NEW.analysis_id OR review.analysis_revision_number <> NEW.analysis_revision_number
    OR review.decision <> 'approve' OR NEW.review_decision <> 'approve'
    OR snapshot.revision_number <> NEW.analysis_revision_number OR snapshot.status <> 'approved'
    OR snapshot.version <> NEW.expected_version OR snapshot.version <> review.version
  THEN RAISE EXCEPTION 'publication requires exact approved revision and workflow version' USING ERRCODE = '23514'; END IF;
  SELECT * INTO gate FROM public.analysis_review_gates WHERE id = review.gate_id FOR UPDATE;
  IF NOT FOUND OR gate.state <> 'reconciled' OR gate.review_id IS DISTINCT FROM review.id THEN
    RAISE EXCEPTION 'review gate must be reconciled before publication' USING ERRCODE = '23514'; END IF;
  NEW.published_at := statement_timestamp();
  UPDATE public.analyses SET status = 'published', version = version + 1 WHERE id = snapshot.id;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.forcare_analysis_workflow_consistency_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target uuid;
  snapshot public.analyses%ROWTYPE;
  gate public.analysis_review_gates%ROWTYPE;
  review public.analysis_reviews%ROWTYPE;
  publication public.analysis_publications%ROWTYPE;
  expected_status text;
BEGIN
  IF TG_TABLE_NAME = 'analyses' THEN target := NEW.id; ELSE target := NEW.analysis_id; END IF;
  SELECT * INTO snapshot FROM public.analyses WHERE id = target FOR UPDATE;
  SELECT * INTO gate FROM public.analysis_review_gates WHERE analysis_id = target AND analysis_revision_number = snapshot.revision_number;
  IF NOT FOUND THEN
    IF snapshot.status <> 'draft' OR snapshot.version <> 0 THEN
      RAISE EXCEPTION 'analysis workflow requires persisted review gate' USING ERRCODE = '23514'; END IF;
    RETURN NULL;
  END IF;
  IF gate.state = 'waiting' THEN
    IF snapshot.status <> 'in_review' OR snapshot.version <> 1 THEN
      RAISE EXCEPTION 'waiting review gate requires in_review snapshot' USING ERRCODE = '23514'; END IF;
    RETURN NULL;
  END IF;
  SELECT * INTO review FROM public.analysis_reviews WHERE id = gate.review_id AND gate_id = gate.id
    AND analysis_id = target AND analysis_revision_number = snapshot.revision_number;
  IF NOT FOUND OR review.expected_version <> 1 THEN
    RAISE EXCEPTION 'decided gate requires exact immutable review' USING ERRCODE = '23514'; END IF;
  expected_status := CASE review.decision WHEN 'approve' THEN 'approved' WHEN 'reject' THEN 'rejected' ELSE 'draft' END;
  SELECT * INTO publication FROM public.analysis_publications WHERE analysis_id = target AND analysis_revision_number = snapshot.revision_number;
  IF FOUND THEN
    IF expected_status <> 'approved' OR gate.state <> 'reconciled' OR publication.review_id <> review.id
      OR snapshot.status <> 'published' OR snapshot.version <> review.version + 1
    THEN RAISE EXCEPTION 'publication workflow must agree with exact approving review' USING ERRCODE = '23514'; END IF;
  ELSIF snapshot.status <> expected_status OR snapshot.version <> review.version THEN
    RAISE EXCEPTION 'analysis workflow must agree with immutable review decision' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER analysis_review_gates_insert_update BEFORE INSERT OR UPDATE ON public.analysis_review_gates
  FOR EACH ROW EXECUTE FUNCTION public.forcare_analysis_review_gate_guard();
CREATE TRIGGER analysis_review_gates_reject_delete BEFORE DELETE ON public.analysis_review_gates
  FOR EACH ROW EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();
CREATE TRIGGER analysis_review_gates_reject_truncate BEFORE TRUNCATE ON public.analysis_review_gates
  FOR EACH STATEMENT EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();
CREATE TRIGGER analysis_reviews_insert BEFORE INSERT ON public.analysis_reviews
  FOR EACH ROW EXECUTE FUNCTION public.forcare_analysis_review_insert_guard();
CREATE TRIGGER analysis_publications_insert BEFORE INSERT ON public.analysis_publications
  FOR EACH ROW EXECUTE FUNCTION public.forcare_analysis_publication_insert_guard();
CREATE TRIGGER analysis_reviews_immutable BEFORE UPDATE OR DELETE ON public.analysis_reviews
  FOR EACH ROW EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();
CREATE TRIGGER analysis_publications_immutable BEFORE UPDATE OR DELETE ON public.analysis_publications
  FOR EACH ROW EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();
CREATE TRIGGER analysis_reviews_reject_truncate BEFORE TRUNCATE ON public.analysis_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();
CREATE TRIGGER analysis_publications_reject_truncate BEFORE TRUNCATE ON public.analysis_publications
  FOR EACH STATEMENT EXECUTE FUNCTION public.forcare_reject_immutable_clinical_mutation();
CREATE CONSTRAINT TRIGGER analyses_workflow_consistency AFTER INSERT OR UPDATE ON public.analyses
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.forcare_analysis_workflow_consistency_guard();
CREATE CONSTRAINT TRIGGER analysis_review_gates_workflow_consistency AFTER INSERT OR UPDATE ON public.analysis_review_gates
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.forcare_analysis_workflow_consistency_guard();
CREATE CONSTRAINT TRIGGER analysis_reviews_workflow_consistency AFTER INSERT ON public.analysis_reviews
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.forcare_analysis_workflow_consistency_guard();
CREATE CONSTRAINT TRIGGER analysis_publications_workflow_consistency AFTER INSERT ON public.analysis_publications
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.forcare_analysis_workflow_consistency_guard();

REVOKE ALL ON TABLE public.analysis_review_gates, public.analysis_reviews, public.analysis_publications FROM PUBLIC;
REVOKE ALL ON FUNCTION public.forcare_analysis_assert_current_revision(uuid) FROM PUBLIC;
