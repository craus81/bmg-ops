-- Migration 016: Knowledge base for AI agent
-- Stores documents/SOPs/specs that the AI can search and reference

CREATE TABLE IF NOT EXISTS knowledge_docs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT, -- e.g. 'SOP', 'spec', 'pricing', 'process', 'policy'
  content TEXT NOT NULL, -- full text content of the document
  tags TEXT[], -- searchable tags
  uploaded_by UUID REFERENCES auth.users(id),
  file_path TEXT, -- optional: path to original file in Supabase storage
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Full text search index
CREATE INDEX IF NOT EXISTS idx_knowledge_docs_search ON knowledge_docs
  USING gin(to_tsvector('english', title || ' ' || COALESCE(content, '')));

CREATE INDEX IF NOT EXISTS idx_knowledge_docs_category ON knowledge_docs(category);
CREATE INDEX IF NOT EXISTS idx_knowledge_docs_tags ON knowledge_docs USING gin(tags);

-- RLS: admin and sales can read, admin can write
ALTER TABLE knowledge_docs ENABLE ROW LEVEL SECURITY;

CREATE POLICY knowledge_docs_select ON knowledge_docs FOR SELECT
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'sales', 'production') AND status = 'approved')
  );

CREATE POLICY knowledge_docs_insert ON knowledge_docs FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin' AND status = 'approved')
  );

CREATE POLICY knowledge_docs_update ON knowledge_docs FOR UPDATE
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin' AND status = 'approved')
  );

CREATE POLICY knowledge_docs_delete ON knowledge_docs FOR DELETE
  USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin' AND status = 'approved')
  );
