import { Pool } from "pg";
import { readFile } from "fs/promises";
import OpenAI from "openai";
import { Agent, tool, run, setDefaultOpenAIClient, setOpenAIAPI } from "@openai/agents";
import { z } from "zod";

export const runtime = "nodejs";

type RetrievedChunk = {
  id: string;
  section: string;
  chunk_text: string;
};

const EMBEDDING_API_KEY = process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
const CHAT_API_KEY = process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const EMBEDDING_BASE_URL =
  process.env.EMBEDDINGS_BASE_URL ||
  process.env.GEMINI_BASE_URL ||
  "https://generativelanguage.googleapis.com/v1beta/openai";
const CHAT_BASE_URL =
  process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "gemini-embedding-001";
const CHAT_MODEL = process.env.CHAT_MODEL || "gpt-4o-mini";
const EMBEDDING_DIM = Number(process.env.EMBEDDING_DIM || "3072");
const EMBEDDINGS_FILE =
  process.env.RESUME_EMBEDDINGS_PATH || "data/resumeEmbeddings.json";
let pool: any = null;
let isAgentsSdkConfigured = false;

const sendPushoverMessage = async (message: string) => {
  const result = await fetch(`${process.env.PUSHOVER_URL}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      token: process.env.PUSHOVER_TOKEN,
      user: process.env.PUSHOVER_USER,
      message
    })
  });

  if (!result.ok) {
    const body = await result.text();
    throw new Error(`Failed to send pushover message (${result.status}): ${body}`);
  }

  return result.json();
};


const recordUserDetailsTool = tool({
  name: "record_user_details",
  description:
    "Use this tool to record that a user is interested in being in touch and provided an email address",
  parameters: z.object({
    email: z.string().describe("The email address of this user")
  }),
  execute: async ({ email }) => {
    console.log("[tool:record_user_details] called with email:", email);
    const data = await sendPushoverMessage(
      `User is interested in being in touch and provided an email address ${email}`
    );
    return { success: true, data };
  }
});

const recordUnknownQuestionTool = tool({
  name: "record_unknown_question",
  description:
    "Always use this tool to record any question that couldn't be answered as you didn't know the answer",
  strict: true,
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description: "The question that couldn't be answered"
      }
    },
    required: ["question"],
    additionalProperties: false
  },
  execute: async (input) => {
    const { question } = input as { question: string };
    const data = await sendPushoverMessage(`Question: "${question}" couldn't be answered`);
    return { success: true, data };
  }
});


// Returns a singleton Postgres pool for database queries.
const getPool = () => {
  if (!DATABASE_URL) return null;
  if (pool) return pool;
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  return pool;
};

const configureAgentsSdk = () => {
  console.log("Configuring agents SDK", isAgentsSdkConfigured);
  if (isAgentsSdkConfigured) return;
  const client = new OpenAI({
    apiKey: CHAT_API_KEY,
    baseURL: CHAT_BASE_URL
  });
  setDefaultOpenAIClient(client);
  setOpenAIAPI("chat_completions");
  isAgentsSdkConfigured = true;
};

// Generates an embedding vector for the provided input text.
const embedText = async (input: string) => {
  const response = await fetch(`${EMBEDDING_BASE_URL}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${EMBEDDING_API_KEY}`
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      input
    })
  });

  if (!response.ok) {
    throw new Error(await response.text());
  }

  const data = await response.json();
  return data.data[0].embedding as number[];
};

// Fetches top matching resume chunks from pgvector similarity search.
const retrieveTopChunks = async (
  client: any,
  question: string,
  topK = 6
): Promise<RetrievedChunk[]> => {
  const questionEmbedding = await embedText(question);
  const queryVector = `[${questionEmbedding.join(",")}]`;
  const result = await client.query(
    `SELECT id, section, chunk_text
     FROM rag_embeddings
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [queryVector, topK]
  );
  return result.rows;
};

// Ensures vector schema exists and seeds embeddings when the table is empty.
const ensureRagTableAndSeed = async (client: any) => {
  await client.query(`
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
  `);

  if (EMBEDDING_DIM <= 2000) {
    await client.query(`
      CREATE INDEX IF NOT EXISTS rag_embeddings_embedding_hnsw_idx
      ON rag_embeddings
      USING hnsw (embedding vector_cosine_ops);
    `);
  }

  const countResult = await client.query("SELECT COUNT(*)::int AS count FROM rag_embeddings");
  const count = Number(countResult.rows?.[0]?.count ?? 0);
  if (count > 0) return;

  const rows = JSON.parse(await readFile(EMBEDDINGS_FILE, "utf8"));
  for (const row of rows) {
    await client.query(
      `INSERT INTO rag_embeddings (id, section, chunk_text, embedding)
       VALUES ($1, $2, $3, $4::vector)
       ON CONFLICT (id) DO UPDATE SET
         section = EXCLUDED.section,
         chunk_text = EXCLUDED.chunk_text,
         embedding = EXCLUDED.embedding`,
      [row.id, row.section, row.chunk_text, `[${row.embedding.join(",")}]`]
    );
  }
};

// Handles chat requests with RAG retrieval and streams model tokens to the client.
export async function POST(request: Request) {
  let client: any;
  try {
    if (!EMBEDDING_API_KEY) {
      return Response.json({ error: "Missing Gemini API key" }, { status: 500 });
    }
    if (!CHAT_API_KEY) {
      return Response.json({ error: "Missing OpenAI API key" }, { status: 500 });
    }
    const dbPool = getPool();
    if (!dbPool) {
      return Response.json({ error: "Missing DATABASE_URL" }, { status: 500 });
    }
    try {
      client = await dbPool.connect();
    } catch (error) {
      return Response.json(
        {
          error:
            "Database connection failed. Check DATABASE_URL (URL-encode special characters in password, e.g. @ as %40).",
          details: error instanceof Error ? error.message : String(error)
        },
        { status: 500 }
      );
    }

    const { message } = await request.json();
    if (!message || typeof message !== "string") {
      return Response.json(
        { error: "Invalid request body: message is required" },
        { status: 400 }
      );
    }

    await ensureRagTableAndSeed(client);
    const chunks: RetrievedChunk[] = await retrieveTopChunks(client, message, 6);
    const context = chunks
      .map(
        (chunk, index) =>
          `Chunk ${index + 1} [${chunk.section} | ${chunk.id}]:\n${chunk.chunk_text}`
      )
      .join("\n\n");

      const systemPrompt = `You are acting as Saddam Japhar. You are answering questions on Saddam Japhar’s website.

      You will receive retrieved text that contains information from Saddam Japhar’s resume and LinkedIn profile. This retrieved text is the ONLY source of truth for professional experience, skills, education, and work history.
      
      PERSONAL BACKGROUND (Non-Professional):
      
      My name is Saddam Japhar. I'm a software development lead. I'm originally from Nepal, and I moved to Houston in 2024.
      
      I enjoy exercising and listening to music. I like most foods, particularly non-vegetarian dishes, and biryani is my favorite. I generally dislike most forms of cheese—not due to allergies, but taste—except for cream cheese and mozzarella. Cheesecake and pizza are my favorites.
      
      WORK AUTHORIZATION:
      
      I am legally authorized to work in the United States. I am currently on a valid work permit and have permanent residency (Green Card).
      
      HOW TO ANSWER:
      
      1. Context-Based Questions
      
      These include questions about experience, skills, technologies, roles, education, certifications, and work history.
      
      - Use ONLY the retrieved resume text provided below as the source of truth.
      - Do NOT use prior knowledge or inference.
      - If a technology, role, or skill is NOT present in the retrieved context:
        - Clearly state that you have not worked on it.
        - Briefly summarize the relevant skills and experience that ARE present.
      - Keep the response concise and professional.
      - Do NOT claim or imply experience you do not have.
      - Be professional and engaging, as if talking to a potential client or future employer who came across the website.
      
      2. General or Conversational Questions
      
      For greetings, introductions, or casual questions:
      - Respond naturally and professionally in character.
      - Do not invent professional details.
      
      STRICT RULES:
      
      - Never fabricate or exaggerate experience.
      - Never claim skills not explicitly present in the retrieved resume.
      
      Tone & Style:
      
      - Professional, clear, and recruiter-friendly.
      - Concise, confident, and honest.
      - Always stay in character as Saddam Japhar.
      - Be professional and engaging, as if talking to a potential client or future employer who came across the website.

      Tools:
      - If you don't know the answer to any question, use your record_unknown_question tool to record the question that you couldn't answer, even if it's about something trivial or unrelated to career.
      - If the user message contains an email address, you MUST call record_user_details with that email before replying.
      - If the user is engaging in discussion, try to steer them towards getting in touch via email; ask for their email and record it using your record_user_details tool and acknowledge that you'll reach out soon.
      - record_user_details: Use this tool to record that a user is interested in being in touch and provided an email address
      - record_unknown_question: Use this tool to record any question that couldn't be answered as you didn't know the answer
      
      Context:
      ${context}
      `;

    configureAgentsSdk();

    const encoder = new TextEncoder();
    const agent = new Agent({
      name: "Saddam Resume Assistant",
      model: CHAT_MODEL,
      instructions: systemPrompt,
      tools: [recordUserDetailsTool, recordUnknownQuestionTool]
    });

    const stream = new ReadableStream({
      async start(controller) {
        try {
          const agentRun = await run(agent, message, { stream: true });
          for await (const event of agentRun) {
            if (
              event.type === "raw_model_stream_event" &&
              event.data?.type === "output_text_delta" &&
              typeof event.data?.delta === "string" &&
              event.data.delta.length > 0
            ) {
              controller.enqueue(encoder.encode(event.data.delta));
            }
          }
          await agentRun.completed;
          controller.close();
        } catch (error) {
          controller.error(error);
        }
      }
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive"
      }
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  } finally {
    if (client) client.release();
  }
}
