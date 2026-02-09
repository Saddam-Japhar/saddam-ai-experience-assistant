import { readFile } from "fs/promises";

const API_KEY = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
const MODEL = process.env.EMBEDDING_MODEL || "gemini-embedding-001";
const BASE_URL =
  process.env.EMBEDDINGS_BASE_URL ||
  "https://generativelanguage.googleapis.com/v1beta/openai";
const EMBEDDINGS_PATH =
  process.env.RESUME_EMBEDDINGS_PATH || "data/resumeEmbeddings.json";

if (!API_KEY) {
  throw new Error("Missing API key in GEMINI_API_KEY or OPENAI_API_KEY");
}

const question = process.argv.slice(2).join(" ").trim();
if (!question) {
  throw new Error('Provide a question: node scripts/retrieveTopChunks.mjs "your question"');
}

const rows = JSON.parse(await readFile(EMBEDDINGS_PATH, "utf8"));

const response = await fetch(`${BASE_URL}/embeddings`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${API_KEY}`
  },
  body: JSON.stringify({
    model: MODEL,
    input: question
  })
});

if (!response.ok) {
  const errorText = await response.text();
  throw new Error(`Embedding request failed: ${errorText}`);
}

const data = await response.json();
const questionEmbedding = data.data[0].embedding;

// Computes cosine similarity between two embedding vectors.
const cosineSimilarity = (a, b) => {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
};

const top3 = rows
  .map((row) => ({
    id: row.id,
    section: row.section,
    chunk_text: row.chunk_text,
    score: cosineSimilarity(questionEmbedding, row.embedding)
  }))
  .sort((a, b) => b.score - a.score)
  .slice(0, 3)
  .map(({ id, section, chunk_text }) => ({ id, section, chunk_text }));

console.log(JSON.stringify(top3, null, 2));
