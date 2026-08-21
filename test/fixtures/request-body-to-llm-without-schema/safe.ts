// @ts-nocheck — fixture is Semgrep pattern-matcher input, not compiled TS.

import OpenAI from "openai";
import { generateText } from "ai";
import { z } from "zod";

const openai = new OpenAI();

const Ask = z.object({
  question: z.string().min(1).max(2000),
});

// Body validated, with a length bound, before it reaches the model.
export async function POST(request: Request) {
  const { question } = Ask.parse(await request.json());
  // ok: request-body-to-llm-without-schema
  const r = await generateText({
    model: "claude-opus-4-7" as any,
    system: "You are concise.",
    prompt: question,
  });
  return Response.json({ text: r.text });
}

// safeParse with an explicit failure path.
export async function ask(request: Request) {
  const parsed = Ask.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: "invalid body" }, { status: 400 });
  }
  // ok: request-body-to-llm-without-schema
  return openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: "You are concise." },
      { role: "user", content: parsed.data.question },
    ],
  });
}

// Hand-rolled validation, no schema library. Type guard, explicit length
// clamp and a named sanitizer are all real validation and must not fire.
const MAX = 5000;

function sanitizeJD(input: string) {
  return input.replace(/[\u200B-\u200D]/g, "").trim();
}

export async function handRolled(request: Request) {
  const { jobDescription } = await request.json();
  if (!jobDescription || typeof jobDescription !== "string") {
    return Response.json({ error: "bad body" }, { status: 400 });
  }
  const clean = sanitizeJD(jobDescription).slice(0, MAX);
  // ok: request-body-to-llm-without-schema
  return generateText({
    model: "claude-opus-4-7" as any,
    system: "You are concise.",
    prompt: clean,
  });
}

// Chat shape: an array of messages validated per element inside .map(),
// with a type guard and a per-message length clamp.
const MAX_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 4000;

export async function chat(request: Request) {
  const { messages } = await request.json();
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: "messages required" }, { status: 400 });
  }
  const trimmed = messages
    .slice(-MAX_MESSAGES)
    .map((msg) => {
      if (typeof msg.content !== "string") return null;
      const role = msg.role === "assistant" ? "assistant" : "user";
      return { role, content: msg.content.slice(0, MAX_MESSAGE_LENGTH) };
    })
    .filter(Boolean);

  // ok: request-body-to-llm-without-schema
  return openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "system", content: "You are concise." }, ...trimmed],
  });
}
