import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const demoDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(demoDir);
const cli = join(rootDir, 'dist', 'cli.js');
const port = Number(process.env.PORT ?? 4517);

const [spec, ...extra] = process.argv.slice(2);
if (!spec) {
  process.stderr.write('usage: node demo/run-demo.mjs <spec relative to demo/> [e2e-mutants run options]\n');
  process.exit(2);
}
if (!existsSync(cli)) {
  process.stderr.write('dist/cli.js is missing: run "npm run build" first\n');
  process.exit(2);
}

function probe() {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function waitForPort(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

if (await probe()) {
  process.stderr.write(`port ${port} is already in use; stop that process or set PORT\n`);
  process.exit(2);
}

const env = { ...process.env, PORT: String(port) };
const server = spawn(process.execPath, [join(demoDir, 'server.mjs')], { env, stdio: ['ignore', 'ignore', 'inherit'] });

const stopServer = () => {
  if (server.exitCode === null) server.kill('SIGTERM');
};
process.on('exit', stopServer);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopServer();
    process.exit(130);
  });
}

if (!(await waitForPort(10_000))) {
  process.stderr.write(`the demo server did not start on port ${port}\n`);
  stopServer();
  process.exit(2);
}

const args = ['run', '--project', demoDir, '--spec', spec, ...extra];
if (!extra.includes('--out')) args.push('--out', join(rootDir, 'e2e-mutants-report', basename(spec).replace(/\.cy\.[cm]?[jt]sx?$/, '')));

const run = spawn(process.execPath, [cli, ...args], { env, stdio: 'inherit' });
run.on('exit', (code, signal) => {
  stopServer();
  process.exit(code ?? (signal ? 130 : 2));
});
