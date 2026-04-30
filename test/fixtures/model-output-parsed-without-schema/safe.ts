// @ts-nocheck — fixture is Semgrep pattern-matcher input, not compiled TS.

import OpenAI from "openai";
import { generateText } from "ai";
import { z } from "zod";

const openai = new OpenAI();

const Reply = z.object({
  user: z.string(),
  balance: z.number(),
});

// Model output validated by zod after parse.
export async function safe1() {
  const r = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: "respond with JSON: { user, balance }" }],
  });
  // ok: model-output-parsed-without-schema
  const data = Reply.parse(JSON.parse(r.choices[0].message.content as string));
  return data;
}

// AI SDK generateText with zod safeParse.
export async function safe2() {
  const r = await generateText({
    model: "claude-opus-4-7" as any,
    prompt: "respond with JSON: { user, balance }",
  });
  const result = Reply.safeParse(JSON.parse(r.text));
  if (!result.success) throw new Error("invalid model output");
  // ok: model-output-parsed-without-schema
  return result.data;
}
