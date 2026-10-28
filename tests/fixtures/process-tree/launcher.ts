import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import process from 'node:process';
import {setTimeout} from 'node:timers';
import {fileURLToPath} from 'node:url';

if (process.argv[2] === 'descendant') {
  // 故意忽略温和终止并保持继承管道；自限寿命防止失败测试泄漏。
  process.on('SIGTERM', () => {});
  if (process.argv[3]) writeFileSync(process.argv[3], String(process.pid));
  process.stdout.write(`${JSON.stringify({jsonrpc: '2.0', method: 'fixture/ready', params: {pid: process.pid}})}\n`);
  process.send?.('ready');
  setTimeout(() => process.exit(0), 8_000);
} else {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'descendant', process.argv[3] ?? ''], {stdio: ['ignore', 'inherit', 'inherit', 'ipc']});
  child.once('message', () => {
    if (process.argv[2] === 'exit-parent') process.exit(0);
  });
  setTimeout(() => process.exit(0), 8_000);
}
