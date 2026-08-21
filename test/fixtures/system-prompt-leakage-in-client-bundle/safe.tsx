// @ts-nocheck — fixture is Semgrep pattern-matcher input, not compiled TS.
"use client";

// A client component that only sends the user's message. The prompt lives
// on the server, where it belongs.
export function Chat({ input }: { input: string }) {
  const send = async () => {
    await fetch("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: input }),
    });
  };
  // ok: system-prompt-leakage-in-client-bundle
  return <button onClick={send}>Send</button>;
}

// Non-prompt constants in a client module are fine.
// ok: system-prompt-leakage-in-client-bundle
const PLACEHOLDER = "Ask me anything about the docs";
// ok: system-prompt-leakage-in-client-bundle
const ERROR_MESSAGE = "Something went wrong. Try again.";

export function Placeholder() {
  return <span title={ERROR_MESSAGE}>{PLACEHOLDER}</span>;
}
