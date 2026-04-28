import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { generateText } from "ai";
import { z } from "zod";

const anthropic = new Anthropic();
const openai = new OpenAI();

const RequestSchema = z.object({
  question: z.string().min(1).max(2000),
});

// System prompt is static, user input goes only into the user role.
export async function safe1(req: any) {
  const { question } = RequestSchema.parse(req.body);
  // ok: untrusted-input-in-system-prompt
  return anthropic.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 1024,
    system: "You are a helpful assistant. Refuse anything off-topic.",
    messages: [{ role: "user", content: question }],
  });
}

// AI SDK with static system, user input only in `prompt`.
export async function safe2(req: any) {
  const { question } = RequestSchema.parse(req.body);
  // ok: untrusted-input-in-system-prompt
  return generateText({
    model: "claude-opus-4-7" as any,
    system: "You are a portfolio assistant. Stay strictly on topic.",
    prompt: question,
  });
}

// OpenAI with static system message.
export async function safe3(req: any) {
  const { question } = RequestSchema.parse(req.body);
  // ok: untrusted-input-in-system-prompt
  return openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: "You are concise and factual." },
      { role: "user", content: question },
    ],
  });
}
