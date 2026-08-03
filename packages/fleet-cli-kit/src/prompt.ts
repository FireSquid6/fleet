import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

export async function promptLine(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Reads a line without echoing it: readline echoes to its output, so it gets a
 * sink and the question is written to stdout directly. Returned untrimmed —
 * whitespace can be part of a password.
 */
export async function promptSecret(question: string): Promise<string> {
  process.stdout.write(question);
  const sink = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const rl = createInterface({ input: process.stdin, output: sink, terminal: true });
  try {
    return await rl.question("");
  } finally {
    // `close()` is what takes stdin back out of raw mode; without the `finally`
    // a throw above leaves the user's shell no longer echoing what they type.
    rl.close();
    process.stdout.write("\n");
  }
}
