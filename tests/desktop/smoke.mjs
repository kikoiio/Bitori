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
let toolCallSequence = 0;
let lastImageDataUrl = null;
const server = createServer((request, response) => {
  if (request.method === 'GET' && String(request.url).endsWith('/models')) {
    response.writeHead(200, {'content-type': 'application/json'});
    response.end(JSON.stringify({object: 'list', data: [
      {id: 'mock-model', display_name: 'Mock Model', is_enabled: true},
      {id: 'test-model', display_name: 'Configured Default', is_enabled: true},
      {id: 'gone-model', display_name: 'Retired Model', is_enabled: false},
    ]}));
    return;
  }
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    const messages = JSON.parse(body).messages || [];
    const latestUser = [...messages].reverse().find(message => message.role === 'user');
    const content = latestUser?.content;
    const userText = Array.isArray(content)
      ? content.filter(part => part && part.type === 'text').map(part => String(part.text || '')).join(' ')
      : String(content ?? '');
    const imagePart = Array.isArray(content) ? content.find(part => part && part.type === 'image_url') : null;
    if (imagePart && imagePart.image_url && typeof imagePart.image_url.url === 'string') lastImageDataUrl = imagePart.image_url.url;
    if (userText.includes('触发图片错误草稿')) {
      response.writeHead(400, {'content-type': 'application/json'});
      response.end(JSON.stringify({error: {message: '测试 Provider 拒绝图片请求'}}));
      return;
    }
    const wantsWait = userText.includes('等待响应');
    if (wantsWait) {
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.write('data: {"choices":[{"delta":{"content":"等待中"},"finish_reason":null}]}\n\n');
      return;
    }
    const denied = userText.includes('拒绝写入');
    const wantsWrite = ['执行写入', '拒绝写入', '本会话写入', '永久写入'].some(marker => userText.includes(marker));
    const wantsMarkdown = userText.includes('渲染 Markdown');
    const afterTool = messages.at(-1)?.role === 'tool';
    const reply = wantsMarkdown
      ? '## 顶层\n\n| 条目 | 说明 |\n| --- | --- |\n| `pwd` | 打印目录 |\n\n- 第一项\n- 第二项\n\n```ts\nconst x = 1\n```\n\n[安全链接](https://docs.qoder.com) · [危险链接](javascript:alert(1))'
      : `测试回复 ${userText} <img src=x>`;
    const chunk = wantsWrite && !afterTool
      ? {choices: [{delta: {tool_calls: [{index: 0, id: `call-${++toolCallSequence}`, type: 'function', function: {name: 'write_file', arguments: JSON.stringify({path: denied ? 'denied.txt' : userText.includes('本会话写入') ? 'session-permission.txt' : userText.includes('永久写入') ? 'permanent-permission.txt' : 'result.txt', content: denied ? 'denied' : userText.includes('本会话写入') ? 'session-approved' : userText.includes('永久写入') ? 'permanent-approved' : 'approved'})}}]}, finish_reason: 'tool_calls'}]}
      : {choices: [{delta: {content: reply}, finish_reason: 'stop'}]};
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
  const screenshotPrefix = process.env.BITORI_SCREENSHOT_PREFIX ?? (packaged ? 'packaged' : '');
  const screenshotPath = name => resolve(`desktop-test-output/${screenshotPrefix ? `${screenshotPrefix}-` : ''}${name}.png`);
  const executablePath = packaged ? resolve(process.env.BITORI_PACKAGED_BINARY ?? 'out/desktop/linux-unpacked/bitori') : require('electron');
  const args = packaged ? ['--disable-gpu', '--no-sandbox'] : [resolve('src/desktop/main.cjs'), '--disable-gpu', '--no-sandbox'];
  application = await electron.launch({executablePath, args, cwd: workspace, timeout: 30000});
  const page = await application.firstWindow();
  await page.getByTestId('request-status').getByText('等待工作区').waitFor({timeout: 30000});
  assert.equal(await page.getByTestId('message-input').isDisabled(), false);
  await page.getByTestId('message-input').fill('草稿');
  assert.equal(await page.getByTestId('message-input').inputValue(), '草稿');
  assert.equal(await page.getByTestId('send').isDisabled(), true);
  await page.getByTestId('message-input').fill('');
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
  await page.screenshot({path: screenshotPath('startup')});
  {
    const originalSessionId = await page.locator('.session[aria-current="page"]').getAttribute('data-session-id');
    assert.ok(originalSessionId, '图片回归需要当前会话');
    const imagePath = resolve('src/desktop/icon.png');
    const archivePath = join(workspace, 'image-session.bitori-session');
    await application.evaluate(({dialog}, paths) => {
      dialog.showOpenDialog = async (_window, options = {}) => {
        if (options.title === '选择图片') return {canceled: false, filePaths: [paths.imagePath]};
        if (options.title === '导入会话') return {canceled: false, filePaths: [paths.archivePath]};
        return {canceled: true, filePaths: []};
      };
      dialog.showSaveDialog = async () => ({canceled: false, filePath: paths.archivePath});
    }, {imagePath, archivePath});

    await page.getByTestId('choose-images').click();
    await page.locator('#attachment-drafts img').waitFor();
    assert.equal(await page.locator('#attachment-drafts .attachment-preview-name').textContent(), 'icon.png');
    await page.getByRole('button', {name: '移除图片 icon.png'}).click();
    await page.locator('#attachment-drafts').waitFor({state: 'hidden'});

    const imageBase64 = (await readFile(imagePath)).toString('base64');
    await application.evaluate(async ({clipboard, ClipboardItem}, data) => {
      const bytes = Uint8Array.from(globalThis.atob(data), character => character.charCodeAt(0));
      const image = new globalThis.Blob([bytes], {type: 'image/png'});
      await clipboard.write([new ClipboardItem({'image/png': image})]);
    }, imageBase64);
    await page.getByTestId('paste-image').click();
    await page.locator('#attachment-drafts img').waitFor();
    assert.equal(await page.locator('#attachment-drafts .attachment-preview-name').textContent(), 'clipboard.png');
    await page.getByRole('button', {name: '移除图片 clipboard.png'}).click();
    await page.locator('#attachment-drafts').waitFor({state: 'hidden'});

    await page.getByTestId('choose-images').click();
    await page.locator('#attachment-drafts img').waitFor();
    await page.getByTestId('new-session').click();
    await page.locator('#attachment-drafts').waitFor({state: 'hidden'});
    await page.locator(`.session[data-session-id="${originalSessionId}"]`).click();
    await page.locator('#attachment-drafts').waitFor({state: 'hidden'});
    await page.getByTestId('choose-images').click();
    await page.locator('#attachment-drafts img').waitFor();
    await page.getByTestId('message-input').fill('触发图片错误草稿');
    await page.getByTestId('send').click();
    await page.getByTestId('error').getByText('测试 Provider 拒绝图片请求').waitFor();
    assert.equal(await page.getByTestId('message-input').inputValue(), '触发图片错误草稿');
    assert.equal(await page.locator('#attachment-drafts img').count(), 1);
    await page.getByTestId('message-input').fill('');
    assert.equal(await page.getByTestId('send').isDisabled(), false, '纯图片消息也应可发送');
    await page.getByTestId('send').click();
    await page.waitForFunction(() => document.querySelectorAll('.message.user img[alt="icon.png"]').length === 2);
    await page.getByTestId('request-status').getByText('就绪').waitFor();
    assert.match(lastImageDataUrl || '', /^data:image\/png;base64,/);

    await page.getByTestId('export-session').click();
    await page.getByTestId('session-feedback').getByText(/会话已导出/).waitFor();
    const archive = JSON.parse(await readFile(archivePath, 'utf8'));
    assert.equal(archive.format, 'bitori-session');
    const archivedImage = archive.conversation.messages.find(message => message.role === 'user')?.attachments?.[0];
    assert.equal(archivedImage?.name, 'icon.png');
    assert.equal(archivedImage?.mediaType, 'image/png');
    assert.ok(archivedImage?.data);
    assert.equal(lastImageDataUrl, `data:image/png;base64,${archivedImage.data}`);

    const sessionCount = await page.locator('[data-testid="session-item"]').count();
    await page.getByTestId('import-session').click();
    await page.getByTestId('session-feedback').getByText(/会话已导入/).waitFor();
    await page.waitForFunction(count => document.querySelectorAll('[data-testid="session-item"]').length === count + 1, sessionCount);
    await page.waitForFunction(() => document.querySelectorAll('.message.user img[alt="icon.png"]').length === 2);
  }
  {
    await page.locator('#composer-plus').click();
    await page.locator('#slash-menu').getByText('/model').waitFor();
    await page.getByTestId('message-input').fill('/model');
    await page.keyboard.press('Enter');
    await page.locator('#model-menu').getByText('test', {exact: true}).waitFor();
    await page.keyboard.press('Escape');
    await page.locator('#model-button').click();
    await page.locator('#model-menu').getByText('test', {exact: true}).waitFor();
    // 模型列表来自 Provider 真实查询;未启用模型必须禁用,选择后运行时立即用新模型。
    await page.locator('#model-menu').getByText('模型/连接测试').click();
    await page.locator('#model-menu').getByText('mock-model · Mock Model').waitFor();
    assert.equal(await page.locator('#model-menu').getByText('gone-model · Retired Model').first().isDisabled(), true);
    await page.locator('#model-menu').getByText('mock-model · Mock Model').click();
    await page.locator('#model-name').getByText('mock-model', {exact: true}).waitFor();
    await page.locator('#model-button').click();
    await page.locator('#model-menu').getByText('test', {exact: true}).waitFor();
    await page.locator('#model-menu').getByText('模型/连接测试').click();
    await page.locator('#model-menu').getByText('使用配置默认(test-model)', {exact: true}).waitFor();
    await page.locator('#model-menu').getByText('使用配置默认(test-model)', {exact: true}).click();
    await page.locator('#model-name').getByText('test-model', {exact: true}).waitFor();
    await page.locator('#model-button').click();
    await page.locator('#model-menu').getByText('test', {exact: true}).waitFor();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Control+=');
    await page.locator('#zoom-badge').waitFor({state: 'visible'});
    await page.keyboard.press('Control+0');
    await page.locator('#zoom-badge').getByText('100%').waitFor();
    await page.locator('#zoom-badge').waitFor({state: 'hidden', timeout: 5000});
  }
  {
    await page.getByTestId('message-input').fill('你好');
    await page.getByTestId('send').click();
    await page.getByText('测试回复 你好 <img src=x>', {exact: true}).waitFor();
    assert.equal(await page.locator('img').count(), 0);
    await page.getByTestId('request-status').getByText('就绪').waitFor();
    await page.getByTestId('new-session').click();
    await page.getByTestId('message-input').fill('执行写入');
    await page.getByTestId('send').click();
    await page.getByTestId('approval').waitFor({state: 'visible'});
    await page.screenshot({path: screenshotPath('approval')});
    assert.equal(existsSync(join(workspace, 'result.txt')), false);
    const staleRejected = await page.evaluate(() => window.bitori.decideApproval('allow_once', 'stale-call').then(() => false, () => true));
    assert.equal(staleRejected, true);
    assert.equal(existsSync(join(workspace, 'result.txt')), false);
    await page.getByTestId('approve-once').click();
    await page.getByText('测试回复 执行写入 <img src=x>', {exact: true}).waitFor();
    assert.equal(await readFile(join(workspace, 'result.txt'), 'utf8'), 'approved');
    // 工具卡片默认展开显示真实 diff,并可撤销 write_file 新建的文件。
    const toolCard = page.locator('details.tool').last();
    await toolCard.locator('.diff-add').first().waitFor();
    await toolCard.getByRole('button', {name: '撤销此修改'}).click();
    await toolCard.getByText(/已删除 Bitori 新建的 result\.txt/).waitFor();
    assert.equal(existsSync(join(workspace, 'result.txt')), false);
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

    // 本会话允许只对同一会话中的精确工具参数生效。
    await page.getByTestId('message-input').fill('本会话写入');
    await page.getByTestId('send').click();
    await page.getByTestId('approval').waitFor({state: 'visible'});
    await page.getByTestId('approve-session').click();
    await page.getByText('测试回复 本会话写入 <img src=x>', {exact: true}).waitFor();
    await page.getByTestId('request-status').getByText('就绪').waitFor();
    assert.equal(await readFile(join(workspace, 'session-permission.txt'), 'utf8'), 'session-approved');
    await rm(join(workspace, 'session-permission.txt'));
    await page.getByTestId('message-input').fill('再次本会话写入');
    await page.getByTestId('send').click();
    await page.getByText('测试回复 再次本会话写入 <img src=x>', {exact: true}).waitFor();
    await page.getByTestId('request-status').getByText('就绪').waitFor();
    assert.equal(await readFile(join(workspace, 'session-permission.txt'), 'utf8'), 'session-approved');
    assert.equal(await page.getByTestId('approval').isVisible().catch(() => false), false);
    await rm(join(workspace, 'session-permission.txt'));
    await page.getByTestId('new-session').click();
    await page.getByTestId('message-input').fill('另一个会话本会话写入');
    await page.getByTestId('send').click();
    await page.getByTestId('approval').waitFor({state: 'visible'});
    assert.equal(existsSync(join(workspace, 'session-permission.txt')), false);
    await page.getByTestId('deny').click();
    await page.getByTestId('request-status').getByText('就绪').waitFor();
    assert.equal(existsSync(join(workspace, 'session-permission.txt')), false);

    // 永久允许写入工作区规则，并可跨会话复用同一精确规则。
    await page.getByTestId('new-session').click();
    await page.getByTestId('message-input').fill('永久写入');
    await page.getByTestId('send').click();
    await page.getByTestId('approval').waitFor({state: 'visible'});
    await page.getByTestId('approve-always').click();
    await page.getByText('测试回复 永久写入 <img src=x>', {exact: true}).waitFor();
    await page.getByTestId('request-status').getByText('就绪').waitFor();
    assert.equal(await readFile(join(workspace, 'permanent-permission.txt'), 'utf8'), 'permanent-approved');
    const localRules = await readFile(join(workspace, '.bitori', 'permissions.local.yaml'), 'utf8');
    assert.match(localRules, /tool: write_file/);
    assert.match(localRules, /pattern: permanent-permission\.txt/);
    assert.match(localRules, /decision: allow/);
    await rm(join(workspace, 'permanent-permission.txt'));
    await page.getByTestId('new-session').click();
    await page.getByTestId('message-input').fill('再次永久写入');
    await page.getByTestId('send').click();
    await page.getByText('测试回复 再次永久写入 <img src=x>', {exact: true}).waitFor();
    await page.getByTestId('request-status').getByText('就绪').waitFor();
    assert.equal(await readFile(join(workspace, 'permanent-permission.txt'), 'utf8'), 'permanent-approved');
    assert.equal(await page.getByTestId('approval').isVisible().catch(() => false), false);

    await page.getByTestId('new-session').click();
    await page.getByTestId('message-input').fill('等待响应');
    await page.getByTestId('send').click();
    await page.getByTestId('message-list').getByText('等待中').waitFor();
    await page.getByTestId('cancel').click();
    await page.getByTestId('request-status').getByText('就绪').waitFor();
    await page.getByTestId('new-session').click();
    await page.getByTestId('message-input').fill('渲染 Markdown');
    await page.getByTestId('send').click();
    await page.locator('.message-body.markdown h2').getByText('顶层').waitFor();
    await page.locator('.message-body.markdown table.md-table').getByText('打印目录').waitFor();
    await page.locator('.message-body.markdown li').getByText('第一项').waitFor();
    assert.equal(await page.locator('.message-body.markdown pre.md-code code').count(), 1);
    assert.equal(await page.locator('.message-body.markdown a.md-link').count(), 1);
    assert.match(await page.locator('.message-body.markdown a.md-link').getAttribute('href'), /^https:\/\/docs\.qoder\.com/);
    assert.equal(await page.locator('img').count(), 0);
    await page.screenshot({path: screenshotPath('markdown')});
    await page.getByTestId('request-status').getByText('就绪').waitFor();
  }
  {
    // 会话搜索、重命名与两步删除。
    const items = () => page.locator('[data-testid="session-item"]');
    const initialCount = await items().count();
    assert.ok(initialCount >= 3, `期望至少 3 个会话，实际 ${initialCount}`);
    await page.getByTestId('session-search').fill('markdown');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="session-item"]').length === 1);
    await page.getByTestId('session-search').fill('');
    await page.waitForFunction(count => document.querySelectorAll('[data-testid="session-item"]').length === count, initialCount);
    const firstSession = items().first();
    const originalTitle = await firstSession.locator('.session-title').textContent();
    assert.ok(originalTitle);
    await firstSession.locator('[aria-label="重命名会话"]').click();
    const renameInput = page.getByLabel('新会话标题');
    await renameInput.fill('未提交草稿');
    await renameInput.evaluate(input => input.setSelectionRange(1, 3));
    const redrawState = await page.evaluate(async () => {
      const previousInput = document.querySelector('.session-rename-input');
      if (previousInput?.tagName !== 'INPUT') throw new Error('重命名回归前置条件缺失');
      await window.bitori.send('重命名期间触发桌面状态刷新');
      await new Promise(resolve => setTimeout(resolve, 500));
      const nextInput = document.querySelector('.session-rename-input');
      const isInput = nextInput?.tagName === 'INPUT';
      return {
        replaced: nextInput !== previousInput,
        focused: document.activeElement === nextInput,
        value: isInput ? nextInput.value : null,
        selectionStart: isInput ? nextInput.selectionStart : null,
        selectionEnd: isInput ? nextInput.selectionEnd : null,
      };
    });
    assert.deepEqual(redrawState, {replaced: true, focused: true, value: '未提交草稿', selectionStart: 1, selectionEnd: 3});
    await page.getByTestId('message-list').getByText('测试回复 重命名期间触发桌面状态刷新 <img src=x>', {exact: true}).waitFor();
    await page.keyboard.press('Escape');
    await page.getByTestId('session-list').getByText(originalTitle, {exact: true}).waitFor();
    await items().first().locator('[aria-label="重命名会话"]').click();
    await page.getByLabel('新会话标题').fill('已重命名会话');
    await page.keyboard.press('Enter');
    await page.getByTestId('session-list').getByText('已重命名会话').waitFor();
    const target = items().filter({hasText: '已重命名会话'});
    await target.locator('[aria-label="删除会话"]').click();
    await target.locator('[aria-label="删除会话"]').getByText('确认?').waitFor();
    await target.locator('[aria-label="删除会话"]').click();
    await page.waitForFunction(count => document.querySelectorAll('[data-testid="session-item"]').length === count, initialCount - 1);
    await page.getByTestId('session-list').getByText('已重命名会话').waitFor({state: 'detached'});
  }
  {
    // 注入仅供 UI 展示的恢复状态，验证确认说明/继续按钮可见；IPC 仍以真实控制器状态为准。
    await application.evaluate(({BrowserWindow}) => {
      const target = BrowserWindow.getAllWindows()[0];
      target.webContents.send('bitori:state', {
        requestStatus: 'idle',
        session: {id: 'recovery-ui-fixture', title: '恢复提示测试'},
        profile: {name: 'test', protocol: 'openai-chat', model: 'test-model'},
        messages: [], toolCalls: [], liveToolCalls: [],
        agentMode: 'execute', permissionTier: 'default', runUsage: null,
        approvalPrompt: null, visibleError: null,
        recovery: {runId: 'recovery-ui-fixture-run', requiresConfirmation: true, message: '中断任务等待确认'},
      });
    });
    await page.getByTestId('recovery').waitFor({state: 'visible'});
    await page.locator('#recovery-message').getByText('中断任务等待确认').waitFor();
    await page.getByText(/检查中断前写入或命令的实际结果/).waitFor();
    await page.getByTestId('recovery-continue').getByText('我已检查，继续恢复').waitFor();
    await page.getByTestId('recovery-continue').click();
    await page.getByTestId('error').getByText('当前没有待恢复任务').waitFor();
  }
  process.stdout.write(`桌面 ${packaged ? '打包应用' : '开发入口'} 冒烟测试通过\n`);
} finally {
  if (application) await application.close().catch(() => {});
  await new Promise(resolveClose => server.close(resolveClose));
  if (configCreated) await rm(configDir, {recursive: true, force: true});
  await rm(workspace, {recursive: true, force: true});
}
