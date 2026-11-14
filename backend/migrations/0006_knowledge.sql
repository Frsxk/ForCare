-- 0006 knowledge (T10): immutable corpus/document/chunk revision identities.
-- Content edits require new IDs and versions. No seed or approval is implicit.
-- Knowledge mutations support READ COMMITTED only. Row locks serialize parent
-- membership checks, but cannot refresh a REPEATABLE READ/SERIALIZABLE snapshot.
-- Enforce isolation in every mutation guard, not just in operator callers.

CREATE TABLE public.knowledge_corpora (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  owner text NOT NULL,
  approved_by uuid,
  approved_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT knowledge_corpora_approved_by_fkey
    FOREIGN KEY (approved_by) REFERENCES public.staff (id) ON DELETE RESTRICT,
  CONSTRAINT knowledge_corpora_name_check CHECK (btrim(name) <> '' AND length(name) <= 200),
  CONSTRAINT knowledge_corpora_version_check CHECK (version >= 1),
  CONSTRAINT knowledge_corpora_owner_check CHECK (btrim(owner) <> '' AND length(owner) <= 300),
  CONSTRAINT knowledge_corpora_status_check CHECK (status IN ('draft', 'approved', 'retired')),
  CONSTRAINT knowledge_corpora_approval_check CHECK (
    (status = 'draft' AND approved_by IS NULL AND approved_at IS NULL)
    OR (status IN ('approved', 'retired') AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
  ),
  CONSTRAINT knowledge_corpora_name_version_unique UNIQUE (name, version)
);

CREATE TABLE public.knowledge_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  corpus_id uuid NOT NULL,
  title text NOT NULL,
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'draft',
  body text NOT NULL,
  checksum text NOT NULL,
  approved_by uuid,
  approved_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT knowledge_documents_corpus_id_fkey
    FOREIGN KEY (corpus_id) REFERENCES public.knowledge_corpora (id) ON DELETE RESTRICT,
  CONSTRAINT knowledge_documents_approved_by_fkey
    FOREIGN KEY (approved_by) REFERENCES public.staff (id) ON DELETE RESTRICT,
  CONSTRAINT knowledge_documents_title_check CHECK (btrim(title) <> '' AND length(title) <= 200),
  CONSTRAINT knowledge_documents_version_check CHECK (version >= 1),
  CONSTRAINT knowledge_documents_body_check CHECK (btrim(body) <> '' AND length(body) <= 20000),
  CONSTRAINT knowledge_documents_checksum_check CHECK (checksum ~ '^[0-9a-f]{64}$'),
  CONSTRAINT knowledge_documents_status_check CHECK (status IN ('draft', 'approved', 'retired')),
  CONSTRAINT knowledge_documents_approval_check CHECK (
    (status = 'draft' AND approved_by IS NULL AND approved_at IS NULL)
    OR (status IN ('approved', 'retired') AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
  ),
  CONSTRAINT knowledge_documents_corpus_title_version_unique UNIQUE (corpus_id, title, version)
);

CREATE TABLE public.knowledge_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL,
  ordinal integer NOT NULL,
  content text NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT knowledge_chunks_document_id_fkey
    FOREIGN KEY (document_id) REFERENCES public.knowledge_documents (id) ON DELETE RESTRICT,
  CONSTRAINT knowledge_chunks_ordinal_check CHECK (ordinal >= 0),
  CONSTRAINT knowledge_chunks_content_check CHECK (btrim(content) <> '' AND length(content) <= 20000),
  CONSTRAINT knowledge_chunks_document_ordinal_unique UNIQUE (document_id, ordinal),
  CONSTRAINT knowledge_chunks_id_document_unique UNIQUE (id, document_id)
);

CREATE INDEX knowledge_chunks_tsv_idx ON public.knowledge_chunks USING gin (tsv);
CREATE INDEX knowledge_corpora_status_name_version_idx
  ON public.knowledge_corpora (status, name, version DESC, id);
CREATE INDEX knowledge_documents_corpus_status_idx
  ON public.knowledge_documents (corpus_id, status, title, version DESC, id);

CREATE FUNCTION public.forcare_reject_immutable_knowledge_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'knowledge mutations require READ COMMITTED isolation' USING ERRCODE = '0A000';
  END IF;
  RAISE EXCEPTION '% is immutable', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION public.forcare_knowledge_snapshot_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'knowledge mutations require READ COMMITTED isolation' USING ERRCODE = '0A000';
  END IF;
  IF NEW.status <> 'draft' OR NEW.approved_by IS NOT NULL OR NEW.approved_at IS NOT NULL THEN
    RAISE EXCEPTION 'knowledge snapshots must begin as unapproved drafts' USING ERRCODE = '23514';
  END IF;

  IF TG_TABLE_NAME = 'knowledge_documents' THEN
    -- All membership and document workflow changes serialize on the corpus row.
    SELECT status INTO parent_status FROM public.knowledge_corpora
      WHERE id = NEW.corpus_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'knowledge document has no parent corpus' USING ERRCODE = '23503';
    END IF;
    IF parent_status <> 'draft' THEN
      RAISE EXCEPTION 'knowledge document membership is fixed at corpus approval' USING ERRCODE = '55000';
    END IF;
  END IF;

  NEW.created_at := now();
  NEW.updated_at := NEW.created_at;
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.forcare_knowledge_snapshot_update_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'knowledge mutations require READ COMMITTED isolation' USING ERRCODE = '0A000';
  END IF;
  -- Everything except the explicit workflow fields is snapshot content,
  -- including IDs, parent membership, immutable version and creation time.
  IF (to_jsonb(NEW) - ARRAY['status', 'approved_by', 'approved_at', 'updated_at'])
    IS DISTINCT FROM
    (to_jsonb(OLD) - ARRAY['status', 'approved_by', 'approved_at', 'updated_at'])
  THEN
    RAISE EXCEPTION 'knowledge snapshot content is immutable' USING ERRCODE = '55000';
  END IF;

  IF NOT (
    (OLD.status = 'draft' AND NEW.status = 'approved')
    OR (OLD.status = 'approved' AND NEW.status = 'retired')
  ) THEN
    RAISE EXCEPTION 'invalid knowledge workflow transition' USING ERRCODE = '23514';
  END IF;

  IF OLD.status = 'approved' AND (
    NEW.approved_by IS DISTINCT FROM OLD.approved_by
    OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
  ) THEN
    RAISE EXCEPTION 'knowledge approval provenance is immutable' USING ERRCODE = '55000';
  END IF;

  IF TG_TABLE_NAME = 'knowledge_documents' THEN
    SELECT status INTO parent_status FROM public.knowledge_corpora
      WHERE id = OLD.corpus_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'knowledge document has no parent corpus' USING ERRCODE = '23503';
    END IF;
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'approved' THEN
    -- Approval records an existing active nurse; it does not provision authority.
    PERFORM 1 FROM public.staff s
      JOIN public.accounts a ON a.id = s.account_id
      JOIN public.account_roles r ON r.account_id = a.id
      WHERE s.id = NEW.approved_by AND s.active AND a.status = 'active' AND r.role = 'nurse'
      FOR SHARE OF s, a, r;
    IF NOT FOUND OR NEW.approved_at IS NULL THEN
      RAISE EXCEPTION 'knowledge approval requires active nurse and approval time' USING ERRCODE = '23514';
    END IF;

    IF TG_TABLE_NAME = 'knowledge_documents' THEN
      IF parent_status <> 'draft' THEN
        RAISE EXCEPTION 'document approval must precede corpus approval' USING ERRCODE = '23514';
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.knowledge_chunks WHERE document_id = OLD.id) THEN
        RAISE EXCEPTION 'knowledge document approval requires chunks' USING ERRCODE = '23514';
      END IF;
    ELSE
      -- The corpus UPDATE holds the same row lock used by child guards. Do not
      -- lock document rows here: document UPDATE already holds its own row lock.
      IF NOT EXISTS (SELECT 1 FROM public.knowledge_documents WHERE corpus_id = OLD.id)
        OR EXISTS (
          SELECT 1 FROM public.knowledge_documents WHERE corpus_id = OLD.id AND status <> 'approved'
        )
      THEN
        RAISE EXCEPTION 'all corpus documents must be approved before corpus approval' USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE FUNCTION public.forcare_knowledge_chunk_insert_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_corpus_id uuid;
  corpus_status text;
  document_status text;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'knowledge mutations require READ COMMITTED isolation' USING ERRCODE = '0A000';
  END IF;
  SELECT corpus_id INTO parent_corpus_id FROM public.knowledge_documents WHERE id = NEW.document_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'knowledge chunk has no parent document' USING ERRCODE = '23503';
  END IF;

  -- The document's corpus ID cannot change. Re-read workflow after acquiring
  -- the shared serialization point so approval cannot race new membership.
  SELECT status INTO corpus_status FROM public.knowledge_corpora
    WHERE id = parent_corpus_id FOR UPDATE;
  SELECT status INTO document_status FROM public.knowledge_documents WHERE id = NEW.document_id;
  IF corpus_status <> 'draft' OR document_status <> 'draft' THEN
    RAISE EXCEPTION 'knowledge chunk membership is fixed at document approval' USING ERRCODE = '55000';
  END IF;

  NEW.created_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER knowledge_corpora_insert_guard
  BEFORE INSERT ON public.knowledge_corpora
  FOR EACH ROW EXECUTE FUNCTION public.forcare_knowledge_snapshot_insert_guard();
CREATE TRIGGER knowledge_corpora_update_guard
  BEFORE UPDATE ON public.knowledge_corpora
  FOR EACH ROW EXECUTE FUNCTION public.forcare_knowledge_snapshot_update_guard();
CREATE TRIGGER knowledge_corpora_reject_delete
  BEFORE DELETE ON public.knowledge_corpora
  FOR EACH ROW EXECUTE FUNCTION public.forcare_reject_immutable_knowledge_mutation();
CREATE TRIGGER knowledge_corpora_reject_truncate
  BEFORE TRUNCATE ON public.knowledge_corpora
  FOR EACH STATEMENT EXECUTE FUNCTION public.forcare_reject_immutable_knowledge_mutation();

CREATE TRIGGER knowledge_documents_insert_guard
  BEFORE INSERT ON public.knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION public.forcare_knowledge_snapshot_insert_guard();
CREATE TRIGGER knowledge_documents_update_guard
  BEFORE UPDATE ON public.knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION public.forcare_knowledge_snapshot_update_guard();
CREATE TRIGGER knowledge_documents_reject_delete
  BEFORE DELETE ON public.knowledge_documents
  FOR EACH ROW EXECUTE FUNCTION public.forcare_reject_immutable_knowledge_mutation();
CREATE TRIGGER knowledge_documents_reject_truncate
  BEFORE TRUNCATE ON public.knowledge_documents
  FOR EACH STATEMENT EXECUTE FUNCTION public.forcare_reject_immutable_knowledge_mutation();

CREATE TRIGGER knowledge_chunks_insert_guard
  BEFORE INSERT ON public.knowledge_chunks
  FOR EACH ROW EXECUTE FUNCTION public.forcare_knowledge_chunk_insert_guard();
CREATE TRIGGER knowledge_chunks_reject_update_delete
  BEFORE UPDATE OR DELETE ON public.knowledge_chunks
  FOR EACH ROW EXECUTE FUNCTION public.forcare_reject_immutable_knowledge_mutation();
CREATE TRIGGER knowledge_chunks_reject_truncate
  BEFORE TRUNCATE ON public.knowledge_chunks
  FOR EACH STATEMENT EXECUTE FUNCTION public.forcare_reject_immutable_knowledge_mutation();

REVOKE ALL ON TABLE public.knowledge_corpora, public.knowledge_documents, public.knowledge_chunks FROM PUBLIC;
