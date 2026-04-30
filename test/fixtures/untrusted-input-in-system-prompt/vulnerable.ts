// @ts-nocheck — fixture is Semgrep pattern-matcher input, not compiled TS.

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { generateText, streamText } from "ai";

const anthropic = new Anthropic();
const openai = new OpenAI();

// Express-style: user input lifted into the Anthropic `system` field.
export async function vuln1(req: any) {
  // ruleid: untrusted-input-in-system-prompt
  return anthropic.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 1024,
    system: req.body.systemPrompt,
    messages: [{ role: "user", content: "hello" }],
  });
}

// Template-literal interpolation does not sanitize the boundary.
export async function vuln2(req: any) {
  // ruleid: untrusted-input-in-system-prompt
  return anthropic.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 1024,
    system: `You are a helpful assistant. Extra rules: ${req.body.extraRules}`,
    messages: [{ role: "user", content: "hello" }],
  });
}

// AI SDK generateText with user input as system.
export async function vuln3(req: any) {
  // ruleid: untrusted-input-in-system-prompt
  return generateText({
    model: "claude-opus-4-7" as any,
    system: req.body.persona,
    prompt: "Tell me about portfolios.",
  });
}

// AI SDK streamText with template-literal system.
export async function vuln4(req: any) {
  // ruleid: untrusted-input-in-system-prompt
  return streamText({
    model: "claude-opus-4-7" as any,
    system: `You are ${req.query.role}. Always answer in JSON.`,
    prompt: "ok",
  });
}

// OpenAI messages array with role: "system" carrying user input.
export async function vuln5(req: any) {
  // ruleid: untrusted-input-in-system-prompt
  return openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: req.body.systemPrompt },
      { role: "user", content: "hi" },
    ],
  });
}
