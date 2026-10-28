import {appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach, describe, expect, it} from 'vitest';
import {JsonlFollower} from '../../../src/cli/commands/tail-file.js';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, {recursive: true, force: true}); });

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'tail-'));
  directories.push(directory);
  const path = join(directory, 'events.jsonl');
  let output = '';
  const follower = new JsonlFollower(path, async text => { output += text; });
  return {path, follower, output: () => output};
}

describe('JSONL tail', () => {
  it('只输出完整行，处理跨读块和跨轮询的 UTF-8', async () => {
    const {path, follower, output} = fixture();
    const prefix = 'a'.repeat(65535);
    const character = Buffer.from('中');
    writeFileSync(path, Buffer.concat([Buffer.from(prefix), character.subarray(0, 1)]));
    await follower.poll();
    expect(output()).toBe('');
    appendFileSync(path, character.subarray(1));
    await follower.poll();
    expect(output()).toBe('');
    appendFileSync(path, '\nnext\npartial');
    await follower.poll();
    expect(output()).toBe(`${prefix}中\nnext\n`);
    appendFileSync(path, '\n');
    await follower.poll();
    expect(output()).toBe(`${prefix}中\nnext\npartial\n`);
  });

  it('忽略启动时已有内容，截断、删除和轮转后从头跟随', async () => {
    const {path} = fixture();
    writeFileSync(path, 'old contents\n');
    let output = '';
    const follower = new JsonlFollower(path, async text => { output += text; });
    await follower.poll();
    expect(output).toBe('');
    appendFileSync(path, 'new\n');
    await follower.poll();
    writeFileSync(path, 'x\n');
    await follower.poll();
    renameSync(path, `${path}.old`);
    writeFileSync(path, 'rotated\n');
    await follower.poll();
    rmSync(path);
    await follower.poll();
    writeFileSync(path, 'created\n');
    await follower.poll();
    expect(output).toBe('new\nx\nrotated\ncreated\n');
  });

  it('等待消费者完成后再发送下一块', async () => {
    const {path} = fixture();
    writeFileSync(path, `${'x'.repeat(65536)}\n`);
    let release: (() => void) | undefined;
    const writes: string[] = [];
    const follower = new JsonlFollower(join(path, '..', 'new.jsonl'), async text => {
      writes.push(text);
      if (writes.length === 1) await new Promise<void>(resolve => { release = resolve; });
    });
    renameSync(path, join(path, '..', 'new.jsonl'));
    const polling = follower.poll();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    expect(writes).toHaveLength(1);
    release();
    await polling;
    expect(writes.join('')).toBe(`${'x'.repeat(65536)}\n`);
  });
});
