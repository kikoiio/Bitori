import {render} from 'ink';
import type {Instance} from 'ink';
import {App} from './app.js';
import type {AppProps} from './app.js';

/** 把 React 根组件交给 Ink 渲染到终端，并返回可等待/卸载的实例。 */
export function renderApp(properties: AppProps): Instance {
  // alternateScreen 使用终端备用屏，退出后能恢复原内容；Ctrl+C 改由应用自己区分“取消”或“退出”。
  return render(<App {...properties} />, {alternateScreen: true, exitOnCtrlC: false, patchConsole: false});
}
