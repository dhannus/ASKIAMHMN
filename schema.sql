-- ════════════════════════════════════════════════════════════════════════════
-- ask.iamhmn.org — Q&A Platform Schema
--
-- Demo platform showcasing HHTTPS OAuth integration. Users log in via
-- hhttps.org, their role and trust score travel along, and every answer
-- displays both transparently.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── Users (cached from HHTTPS — pairwise subject IDs) ───────────────────────
-- We don't store any PII. The "user" here is a pairwise subject ID we
-- received from hhttps.org for this client. Role and trust are cached
-- for performance; periodically refreshed via /userinfo.
CREATE TABLE IF NOT EXISTS users (
  id                    VARCHAR(32) PRIMARY KEY,        -- pairwise sub from HHTTPS
  actor_type            VARCHAR(10) NOT NULL DEFAULT 'human', -- 'human' or 'bot'
  role                  VARCHAR(40) NOT NULL,
  role_label            VARCHAR(80),
  role_icon             VARCHAR(20),
  trust_score           INTEGER NOT NULL DEFAULT 30,
  verification_method   VARCHAR(40),
  verification_label    VARCHAR(80),
  display_name          VARCHAR(40),                    -- generated, e.g. "Doc-XQ9N"
  operator_name         VARCHAR(120),                   -- for bots: from HHTTPS machine token
  operator_purpose      TEXT,                           -- for bots: declared purpose
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent: ensure new columns exist on already-created tables
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='users' AND column_name='actor_type') THEN
    ALTER TABLE users ADD COLUMN actor_type VARCHAR(10) NOT NULL DEFAULT 'human';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='users' AND column_name='operator_name') THEN
    ALTER TABLE users ADD COLUMN operator_name VARCHAR(120);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='users' AND column_name='operator_purpose') THEN
    ALTER TABLE users ADD COLUMN operator_purpose TEXT;
  END IF;
END$$;

-- ─── Questions ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS questions (
  id              SERIAL PRIMARY KEY,
  asker_id        VARCHAR(32) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           VARCHAR(200) NOT NULL,
  body            TEXT NOT NULL,
  category        VARCHAR(40) NOT NULL,
  tags            TEXT[],                       -- e.g. {'medizin','herz'}
  view_count      INTEGER NOT NULL DEFAULT 0,
  answer_count    INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_questions_category   ON questions(category);
CREATE INDEX IF NOT EXISTS idx_questions_created    ON questions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_questions_asker      ON questions(asker_id);

-- ─── Answers ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS answers (
  id                  SERIAL PRIMARY KEY,
  question_id         INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  answerer_id         VARCHAR(32) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body                TEXT NOT NULL,

  -- Snapshot of role + trust + actor at answer time
  answerer_actor_type  VARCHAR(10) NOT NULL DEFAULT 'human',
  answerer_role       VARCHAR(40) NOT NULL,
  answerer_role_label VARCHAR(80),
  answerer_role_icon  VARCHAR(20),
  answerer_trust      INTEGER NOT NULL,
  answerer_verification VARCHAR(40),

  -- Asker can mark an answer as "this helped"
  marked_helpful      BOOLEAN NOT NULL DEFAULT FALSE,
  marked_helpful_at   TIMESTAMPTZ,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_answers_question  ON answers(question_id);
CREATE INDEX IF NOT EXISTS idx_answers_answerer  ON answers(answerer_id);

-- Idempotent: ensure new columns exist on already-created tables
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name='answers' AND column_name='answerer_actor_type') THEN
    ALTER TABLE answers ADD COLUMN answerer_actor_type VARCHAR(10) NOT NULL DEFAULT 'human';
  END IF;
END$$;

-- ─── Categories registry ────────────────────────────────────────────────────
-- We define which roles are "qualified" for each category. Other roles can
-- still answer, but their answers get a "no domain verification" warning.
CREATE TABLE IF NOT EXISTS categories (
  slug              VARCHAR(40) PRIMARY KEY,
  label             VARCHAR(80) NOT NULL,
  label_en          VARCHAR(80),
  icon              VARCHAR(20),
  description       TEXT,
  qualified_roles   TEXT[] NOT NULL,
  sort_order        INTEGER NOT NULL DEFAULT 0
);

INSERT INTO categories (slug, label, label_en, icon, description, qualified_roles, sort_order) VALUES
  ('medizin',     'Medizin',      'Medicine',     '🩺', 'Gesundheit, Diagnose-Hinweise, Medikamente',
    ARRAY['medical_professional','caregiver'], 1),
  ('recht',       'Recht',         'Law',          '⚖️', 'Rechtsfragen, Vertragsrecht, Verwaltung',
    ARRAY['lawyer','notary'], 2),
  ('tech',        'Technik',       'Tech',         '💻', 'IT, Programmierung, Software',
    ARRAY['developer'], 3),
  ('bildung',     'Bildung',       'Education',    '👨‍🏫', 'Pädagogik, Wissenschaft, Lernen',
    ARRAY['teacher','researcher','student'], 4),
  ('politik',     'Politik',       'Politics',     '🏛️', 'Politik, Verwaltung, Bürgerrechte',
    ARRAY['politician','civil_servant'], 5),
  ('handwerk',    'Handwerk',      'Trades',       '🔧', 'Handwerkliche Fragen, Reparaturen, Baugewerbe',
    ARRAY['craftsman'], 6),
  ('wirtschaft',  'Wirtschaft',    'Business',     '🏢', 'Unternehmertum, Finanzen, Markt',
    ARRAY['business'], 7),
  ('allgemein',   'Allgemein',     'General',      '📰', 'Allgemeine Fragen, keine spezielle Fachrichtung',
    ARRAY['citizen','journalist','creative'], 8)
ON CONFLICT (slug) DO NOTHING;

-- ─── Grants ──────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'askhuman') THEN
    ALTER TABLE users      OWNER TO askhuman;
    ALTER TABLE questions  OWNER TO askhuman;
    ALTER TABLE answers    OWNER TO askhuman;
    ALTER TABLE categories OWNER TO askhuman;
    GRANT SELECT, INSERT, UPDATE, DELETE ON
      users, questions, answers, categories TO askhuman;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO askhuman;
  END IF;
END$$;
