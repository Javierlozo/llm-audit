import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { generateText, generateObject } from "ai";
import { exec, execSync } from "node:child_process";

const anthropic = new Anthropic();
const openai = new OpenAI();

// Model output piped straight into eval.
export async function vuln1() {
  const r = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: "give me js code" }],
  });
  // ruleid: llm-output-insecure-handling
  return eval(r.choices[0].message.content as string);
}

// Model output passed to new Function.
export async function vuln2() {
  const r = await generateText({
    model: "claude-opus-4-7" as any,
    prompt: "write a one-liner",
  });
  // ruleid: llm-output-insecure-handling
  return new Function(r.text)();
}

// Model output flowing into a child_process exec.
export async function vuln3() {
  const r = await anthropic.messages.create({
    model: "claude-opus-4-7",
    max_tokens: 256,
    messages: [{ role: "user", content: "give me a shell command" }],
  });
  // ruleid: llm-output-insecure-handling
  exec((r.content[0] as any).text);
}

// Model output rendered as raw HTML in the DOM.
export async function vuln4(el: HTMLElement) {
  const r = await generateText({
    model: "claude-opus-4-7" as any,
    prompt: "give me html",
  });
  // ruleid: llm-output-insecure-handling
  el.innerHTML = r.text;
}

// Model output passed to dangerouslySetInnerHTML in JSX.
export async function VulnComponent() {
  const r = await generateText({
    model: "claude-opus-4-7" as any,
    prompt: "give me html",
  });
  // ruleid: llm-output-insecure-handling
  return <div dangerouslySetInnerHTML={{ __html: r.text }} />;
}

// execSync with a model-derived string.
export async function vuln5() {
  const r = await generateObject({
    model: "claude-opus-4-7" as any,
    schema: {} as any,
    prompt: "produce { cmd: string }",
  });
  // ruleid: llm-output-insecure-handling
  execSync((r.object as any).cmd);
}
