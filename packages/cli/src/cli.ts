import { type CliIo, runCli } from './index.js';

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const io: CliIo = {
    readStdin: readAllStdin,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
  };
  return runCli(argv, io);
}
