import { readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";

console.log("Generating embeddings...");
console.log("API_KEY:", JSON.stringify(process.env.GEMINI_API_KEY, null, 2));


const API_KEY = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
const MODEL = process.env.EMBEDDING_MODEL || "gemini-embedding-001";
const BASE_URL =
  process.env.EMBEDDINGS_BASE_URL ||
  "https://generativelanguage.googleapis.com/v1beta/openai";

const inputPath =
  process.env.RESUME_CHUNKS_PATH || "data/resumeChunks.json";

if (!API_KEY) {
  throw new Error("Missing API key in GEMINI_API_KEY or OPENAI_API_KEY");
}

const chunks = JSON.parse(await readFile(inputPath, "utf8"));

const output = [];

for (const chunk of chunks) {
  const response = await fetch(`${BASE_URL}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      input: chunk.chunk_text
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Embedding request failed: ${errorText}`);
  }

  const data = await response.json();
  output.push({
    id: chunk.id,
    section: chunk.section,
    chunk_text: chunk.chunk_text,
    embedding: data.data[0].embedding
  });
}

const outputPath = join(dirname(inputPath), "resumeEmbeddings.json");
await writeFile(outputPath, JSON.stringify(output, null, 2), "utf8");
console.log(`Saved ${output.length} embeddings to ${outputPath}`);
