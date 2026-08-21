// @ts-nocheck — fixture is Semgrep pattern-matcher input, not compiled TS.

import { generateText } from "ai";

const handlers = {
  readFile: async (a) => a,
  deleteAccount: async (a) => a,
  sendEmail: async (a) => a,
};

// The model picks the tool, the map dispatches it. No allowlist.
export async function vuln1(req) {
  const r = await generateText({
    model: "claude-opus-4-7" as any,
    prompt: req.body.text,
    tools: handlers as any,
  });
  for (const call of r.toolCalls ?? []) {
    // ruleid: tool-call-dispatch-without-allowlist
    await handlers[call.toolName](call.args);
  }
}

// OpenAI shape: tool_calls carry function.name.
export async function vuln2(completion) {
  for (const call of completion.choices[0].message.tool_calls ?? []) {
    // ruleid: tool-call-dispatch-without-allowlist
    await handlers[call.function.name](JSON.parse(call.function.arguments));
  }
}

// Resolved to a variable first, then invoked. Same hole.
export async function vuln3(call) {
  // ruleid: tool-call-dispatch-without-allowlist
  const fn = handlers[call.toolName];
  return await fn(call.args);
}
