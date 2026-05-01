/**
 * Designing Immersion — Chat-with-the-book Worker
 * ------------------------------------------------
 * Receives chat messages from the site, fetches the book corpus from R2,
 * sends both to Cloudflare Workers AI, returns the answer as JSON.
 *
 * BINDINGS REQUIRED (configured in Cloudflare dashboard):
 *   AI       → Workers AI
 *   BOOK     → R2 bucket containing book-corpus.txt (use your existing "book" bucket)
 *
 * MODEL: Llama 3.3 70B Instruct — best free model available on Workers AI for
 * grounded Q&A. Swap MODEL constant if you upgrade or switch later.
 */

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// CORS headers — adjust ALLOWED_ORIGIN to your Pages URL once deployed
const ALLOWED_ORIGIN = "*"; // tighten this to e.g. "https://designing-immersion.pages.dev"
const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Cache the corpus in module scope so we don't fetch from R2 on every request
let cachedCorpus = null;
async function getBookCorpus(env) {
  if (cachedCorpus) return cachedCorpus;
  const obj = await env.BOOK.get("book-corpus.txt");
  if (!obj) throw new Error("book-corpus.txt not found in R2 bucket 'book'");
  cachedCorpus = await obj.text();
  return cachedCorpus;
}

// System prompt that locks the model into "only what's in the book" behavior
function buildSystemPrompt(corpus) {
  return `You are the book "Designing Immersion: The Future of Simulation-Based Clinical Education" speaking to a reader.

You ONLY know what is in the book content provided below. You do not have any other knowledge of the world, current events, medicine, design, or simulation.

RULES:
1. Answer ONLY using information from the book content below.
2. If the answer is not in the book, say exactly: "That isn't covered in the book." Do not guess, infer, or use outside knowledge.
3. When you reference a specific section, vignette, or character, mention it by name (e.g. "in Maya Okafor's morning vignette" or "in Section 2 on research methodology").
4. Keep answers concise — 2-4 sentences unless the user asks for more detail.
5. Speak naturally, like a thoughtful guide to the book. Don't start with "Based on the text" or similar.
6. Never say "I think" or "I believe" — you only know what the book says.

BOOK CONTENT:
---
${corpus}
---

End of book content. Answer the reader's question using only the above.`;
}

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders });
    }

    try {
      const { messages = [] } = await request.json();
      if (!Array.isArray(messages) || messages.length === 0) {
        return Response.json({ error: "no messages" }, { status: 400, headers: corsHeaders });
      }

      // Basic abuse guard: cap message length and conversation depth
      const lastUserMsg = messages[messages.length - 1];
      if (lastUserMsg.content && lastUserMsg.content.length > 1500) {
        return Response.json({ error: "message too long" }, { status: 400, headers: corsHeaders });
      }
      if (messages.length > 20) {
        // Trim to last 20 turns to keep context bounded
        messages.splice(0, messages.length - 20);
      }

      const corpus = await getBookCorpus(env);
      const systemPrompt = buildSystemPrompt(corpus);

      // Construct the message list for Workers AI
      const aiMessages = [
        { role: "system", content: systemPrompt },
        ...messages.map(m => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: String(m.content || "").slice(0, 1500),
        })),
      ];

      const aiResponse = await env.AI.run(MODEL, {
        messages: aiMessages,
        max_tokens: 512,
        temperature: 0.2, // low — we want grounded, not creative
      });

      const reply = (aiResponse && aiResponse.response) ? aiResponse.response.trim() : "";
      if (!reply) {
        return Response.json({ error: "empty model response" }, { status: 502, headers: corsHeaders });
      }

      return Response.json({ reply }, { headers: corsHeaders });
    } catch (err) {
      console.error("Chat worker error:", err);
      return Response.json(
        { error: err.message || "internal error" },
        { status: 500, headers: corsHeaders }
      );
    }
  },
};
