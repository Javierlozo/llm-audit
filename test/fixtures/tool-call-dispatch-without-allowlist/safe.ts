// @ts-nocheck — fixture is Semgrep pattern-matcher input, not compiled TS.

import { z } from "zod";

const readFile = async (a) => a;
const sendEmail = async (a) => a;

// Closed set of literal names. The model cannot reach anything else.
export async function safe1(call) {
  switch (call.toolName) {
    // ok: tool-call-dispatch-without-allowlist
    case "readFile":
      return readFile(call.args);
    // ok: tool-call-dispatch-without-allowlist
    case "sendEmail":
      return sendEmail(call.args);
    default:
      throw new Error(`unknown tool: ${call.toolName}`);
  }
}

// Explicit allowlist membership check, plus schema-validated arguments.
const ALLOWED = new Set(["readFile", "sendEmail"]);
const Args = z.object({ path: z.string() });

export async function safe2(call, handlers) {
  if (!ALLOWED.has(call.toolName)) {
    throw new Error("tool not allowed");
  }
  const args = Args.parse(call.args);
  // ok: tool-call-dispatch-without-allowlist
  return handlers[call.toolName](args);
}
