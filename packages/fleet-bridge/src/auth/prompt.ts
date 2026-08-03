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
 * Reads a line without echoing it: readline writes its own echo, so it is given
 * a sink instead of stdout and the question is printed directly. The answer is
 * returned untrimmed — whitespace can be part of a password.
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
    // `close()` is what takes stdin back out of raw mode. Without it in a
    // `finally`, a throw or a Ctrl-C anywhere above leaves the user staring at
    // a shell that no longer echoes what they type.
    rl.close();
    process.stdout.write("\n");
  }
}
