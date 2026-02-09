import { readFile } from "fs/promises";
import { Pool } from "pg";

const DATABASE_URL = process.env.DATABASE_URL;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "gemini-embedding-001";
const EMBEDDINGS_BASE_URL =
  process.env.EMBEDDINGS_BASE_URL ||
  "https://generativelanguage.googleapis.com/v1beta/openai";
const EMBEDDINGS_PATH =
  process.env.RESUME_EMBEDDINGS_PATH || "data/resumeEmbeddings.json";
const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM || "3072");

if (!DATABASE_URL) throw new Error("Missing DATABASE_URL");
if (!GEMINI_API_KEY) throw new Error("Missing GEMINI_API_KEY");

const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

const schemaSql = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS rag_embeddings (
  id TEXT PRIMARY KEY,
  section TEXT NOT NULL,
  chunk_text TEXT NOT NULL,
  embedding VECTOR(${EMBEDDING_DIM}) NOT NULL
);
ALTER TABLE rag_embeddings
ALTER COLUMN embedding TYPE VECTOR(${EMBEDDING_DIM})
USING embedding::vector(${EMBEDDING_DIM});
`;

// Converts a numeric embedding array into pgvector literal format.
const toVectorLiteral = (arr) => `[${arr.join(",")}]`;

// Generates an embedding vector for the provided input text.
const embedText = async (input) => {
  const response = await fetch(`${EMBEDDINGS_BASE_URL}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GEMINI_API_KEY}`
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input
    })
  });

  if (!response.ok) throw new Error(await response.text());
  const data = await response.json();
  return data.data[0].embedding;
};

// Upserts all local embedding records into the rag_embeddings table.
const upsertEmbeddings = async (client) => {
  const rows = JSON.parse(await readFile(EMBEDDINGS_PATH, "utf8"));
  await client.query("BEGIN");
  try {
    for (const row of rows) {
      await client.query(
        `INSERT INTO rag_embeddings (id, section, chunk_text, embedding)
         VALUES ($1, $2, $3, $4::vector)
         ON CONFLICT (id) DO UPDATE SET
           section = EXCLUDED.section,
           chunk_text = EXCLUDED.chunk_text,
           embedding = EXCLUDED.embedding`,
        [row.id, row.section, row.chunk_text, toVectorLiteral(row.embedding)]
      );
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
};

// Queries the three most similar chunks from Postgres using cosine distance.
const queryTop3 = async (client, question) => {
  const queryEmbedding = await embedText(question);
  const result = await client.query(
    `SELECT id, section, chunk_text
     FROM rag_embeddings
     ORDER BY embedding <=> $1::vector
     LIMIT 3`,
    [toVectorLiteral(queryEmbedding)]
  );
  return result.rows;
};

// Runs schema setup, data upsert, and sample retrieval for validation.
const main = async () => {
  const question = process.argv.slice(2).join(" ").trim();
  if (!question) throw new Error('Usage: node scripts/ragPostgres.mjs "your question"');

  const client = await pool.connect();
  try {
    await client.query(schemaSql);
    if (EMBEDDING_DIM <= 2000) {
      await client.query(`
        CREATE INDEX IF NOT EXISTS rag_embeddings_embedding_hnsw_idx
          ON rag_embeddings
          USING hnsw (embedding vector_cosine_ops);
      `);
    }
    await upsertEmbeddings(client);
    const top3 = await queryTop3(client, question);
    console.log(JSON.stringify(top3, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
};

await main();
