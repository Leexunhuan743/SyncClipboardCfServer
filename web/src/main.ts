// 入口：先探测会话，再决定显示登录页还是应用。登录/退出都只是在同一页里切换状态。
import { api } from './lib/api';
import { clear } from './lib/dom';
import { startApp, type AppHandle, type SessionEnd } from './app';
import { initTheme } from './theme';
import { createLogin } from './views/login';

initTheme();

const root = document.getElementById('app');
if (!root) throw new Error('缺少 #app 挂载点');

let handle: AppHandle | null = null;

function showLogin(reason: SessionEnd | null = null): void {
  handle?.stop();
  handle = null;
  const login = createLogin((username) => showApp(username), reason === 'expired' ? '登录已过期，请重新登录。' : null);
  clear(root!).append(login.el);
  document.title = '登录 · 剪贴板';
  login.focus();
}

function showApp(username: string): void {
  document.title = '剪贴板 · SyncClipboard';
  handle = startApp(root!, username, (reason) => showLogin(reason));
}

api.session().then(
  (session) => (session.authenticated && session.username ? showApp(session.username) : showLogin()),
  () => showLogin(),
);
