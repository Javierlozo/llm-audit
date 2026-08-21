// @ts-nocheck — fixture is Semgrep pattern-matcher input, not compiled TS.
"use client";

import { generateText } from "ai";

// Ships in the bundle. Anyone can read it in devtools.
// ruleid: system-prompt-leakage-in-client-bundle
const SYSTEM_PROMPT =
  "You are the support agent for ACME. Never discuss refunds above $500. Internal tool: refund_api.";

export function Chat({ input }: { input: string }) {
  return <div>{SYSTEM_PROMPT.length > 0 ? input : null}</div>;
}

// Prompt text inlined at the call site, still in a client module.
export async function ask(input: string) {
  // ruleid: system-prompt-leakage-in-client-bundle
  return generateText({
    model: "claude-opus-4-7" as any,
    system: "You are a billing assistant with access to the internal ledger.",
    prompt: input,
  });
}
