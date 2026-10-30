import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createRequire} from 'node:module';
import {_electron as electron} from 'playwright-core';

const require = createRequire(import.meta.url);
const configDir = join(homedir(), '.bitori');
if (existsSync(configDir)) throw new Error('桌面测试需要隔离的用户目录，拒绝覆盖现有 .bitori');
const workspace = await mkdtemp(join(tmpdir(), 'bitori-desktop-'));
let application;
let configCreated = false;
const server = createServer((request, response) => {
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    const messages = JSON.parse(body).messages || [];
    const wantsWait = messages.some(message => message.role === 'user' && String(message.content).includes('等待响应'));
    if (wantsWait) {
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.write('data: {"choices":[{"delta":{"content":"等待中"},"finish_reason":null}]}\n\n');
      return;
    }
    const denied = messages.some(message => message.role === 'user' && String(message.content).includes('拒绝写入'));
    const wantsWrite = denied || messages.some(message => message.role === 'user' && String(message.content).includes('执行写入'));
    const afterTool = messages.some(message => message.role === 'tool');
    const chunk = wantsWrite && !afterTool
      ? {choices: [{delta: {tool_calls: [{index: 0, id: 'call-test', type: 'function', function: {name: 'write_file', arguments: JSON.stringify({path: denied ? 'denied.txt' : 'result.txt', content: 'approved'})}}]}, finish_reason: 'tool_calls'}]}
      : {choices: [{delta: {content: '测试回复 <img src=x>'}, finish_reason: 'stop'}]};
    response.writeHead(200, {'content-type': 'text/event-stream'});
    response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  });
});
try {
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const port = server.address().port;
  await mkdir(configDir);
  configCreated = true;
  await writeFile(join(configDir, 'config.yaml'), `profiles:\n  - name: test\n    protocol: openai-chat\n    model: test-model\n    base_url: http://127.0.0.1:${port}/v1\n    api_key: \${TEST_KEY}\n`);
  await writeFile(join(configDir, '.env'), 'TEST_KEY=desktop-test\n');
  const packaged = process.env.BITORI_PACKAGED === '1';
  const executablePath = packaged ? resolve('out/desktop/linux-unpacked/bitori') : require('electron');
  const args = packaged ? ['--disable-gpu', '--no-sandbox'] : [resolve('src/desktop/main.cjs'), '--disable-gpu', '--no-sandbox'];
  application = await electron.launch({executablePath, args, cwd: workspace, timeout: 30000});
  const page = await application.firstWindow();
  await page.getByTestId('request-status').getByText('等待配置').waitFor({timeout: 30000});
  await application.evaluate(({dialog}, directory) => {
    let confirmations = 0;
    dialog.showOpenDialog = async () => ({canceled: false, filePaths: [directory]});
    dialog.showMessageBox = async () => ({response: confirmations++ === 0 ? 0 : 1, checkboxChecked: false});
  }, workspace);
  await page.getByTestId('choose-workspace').click();
  await page.getByTestId('workspace').getByText('未选择工作区').waitFor();
  await page.getByTestId('choose-workspace').click();
  await page.getByTestId('request-status').getByText('就绪').waitFor({timeout: 30000});
  assert.equal(await page.getByTestId('profile-select').inputValue(), 'test');
  await mkdir(resolve('desktop-test-output'), {recursive: true});
  await page.screenshot({path: resolve(`desktop-test-output/${packaged ? 'packaged' : 'startup'}.png`)});
  {
    await page.getByTestId('message-input').fill('你好');
    await page.getByTestId('send').click();
    await page.getByText('测试回复 <img src=x>').waitFor();
    assert.equal(await page.locator('img').count(), 0);
    await page.getByTestId('request-status').getByText('就绪').waitFor();
    await page.getByTestId('new-session').click();
    await page.getByTestId('message-input').fill('执行写入');
    await page.getByTestId('send').click();
    await page.getByTestId('approval').waitFor({state: 'visible'});
    await page.screenshot({path: resolve(`desktop-test-output/${packaged ? 'packaged-' : ''}approval.png`)});
    assert.equal(existsSync(join(workspace, 'result.txt')), false);
    const staleRejected = await page.evaluate(() => window.bitori.decideApproval('allow', 'stale-call').then(() => false, () => true));
    assert.equal(staleRejected, true);
    assert.equal(existsSync(join(workspace, 'result.txt')), false);
    await page.getByTestId('approve').click();
    await page.getByText('测试回复 <img src=x>').waitFor();
    assert.equal(await readFile(join(workspace, 'result.txt'), 'utf8'), 'approved');
    await page.getByTestId('request-status').getByText('就绪').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('[data-session-id]').length >= 2);
    await page.locator('[data-session-id]').last().click();
    await page.getByTestId('message-list').getByText('你好', {exact: true}).waitFor();
    await page.getByTestId('new-session').click();
    await page.getByTestId('message-input').fill('拒绝写入');
    await page.getByTestId('send').click();
    await page.getByTestId('approval').waitFor({state: 'visible'});
    await page.getByTestId('deny').click();
    await page.getByTestId('request-status').getByText('就绪').waitFor();
    assert.equal(existsSync(join(workspace, 'denied.txt')), false);
    await page.getByTestId('new-session').click();
    await page.getByTestId('message-input').fill('等待响应');
    await page.getByTestId('send').click();
    await page.getByTestId('message-list').getByText('等待中').waitFor();
    await page.getByTestId('cancel').click();
    await page.getByTestId('request-status').getByText('就绪').waitFor();
  }
  process.stdout.write(`桌面 ${packaged ? '打包应用' : '开发入口'} 冒烟测试通过\n`);
} finally {
  if (application) await application.close().catch(() => {});
  await new Promise(resolveClose => server.close(resolveClose));
  if (configCreated) await rm(configDir, {recursive: true, force: true});
  await rm(workspace, {recursive: true, force: true});
}
