CREATE EXTENSION IF NOT EXISTS vector;

-- Separate database for the integration tests: they empty their tables, so they must never touch moj_n8n.
CREATE DATABASE moj_n8n_test OWNER moj_n8n;
\c moj_n8n_test
CREATE EXTENSION IF NOT EXISTS vector;
