// 登录页：一个表单、一处错误位、一个 pending 态。
import { api, ApiError } from './api.js';
import { resolveNext } from './next-target.js';

// 顶部提示条：与列表页（js/main.js）共用同一个 localStorage 键与同一套行为。
// 键名两处必须逐字一致 —— 不一致的后果是"在登录页关掉了，进列表页又冒出来"。
const NOTICE_KEY = 'sb-ui-notice-dismissed';

function initNoticeBar() {
  const bar = document.getElementById('notice-bar');
  const close = document.getElementById('notice-bar-close');
  if (!bar || !close) return;
  try {
    if (localStorage.getItem(NOTICE_KEY) === '1') {
      bar.hidden = true;
      return;
    }
  } catch {
    /* 隐私模式读不到 localStorage：当作从没关过，继续显示提示条 */
  }
  close.addEventListener('click', () => {
    bar.hidden = true;
    try {
      localStorage.setItem(NOTICE_KEY, '1');
    } catch {
      /* 写不了就只是"下次还显示"，不值得打断页面 */
    }
  });
}

initNoticeBar();

const form = document.getElementById('login-form');
const errorBox = document.getElementById('login-error');
const submit = document.getElementById('login-submit');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');

// `?next=` 只在**同源**时才用作跳转目标（判定实现见 next-target.js：前缀比较挡不住
// `/\evil.example` 这类反斜杠变体）。解析失败或跨源一律回落站内默认页。
const nextUrl = resolveNext(new URLSearchParams(location.search).get('next'), location.origin) ?? '/ui_old/';

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function clearError() {
  errorBox.hidden = true;
  errorBox.textContent = '';
}

function setLoading(loading) {
  submit.dataset.loading = String(loading);
  submit.disabled = loading;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = usernameInput.value.trim();
  const password = passwordInput.value;

  if (!username || !password) {
    showError('请输入用户名和密码。');
    (username ? passwordInput : usernameInput).focus();
    return;
  }

  clearError();
  setLoading(true);
  try {
    await api.login(username, password);
    location.replace(nextUrl);
  } catch (error) {
    setLoading(false);
    if (error instanceof ApiError && error.status === 401) {
      showError('用户名或密码不正确。');
      passwordInput.select();
      return;
    }
    if (error instanceof ApiError && error.status === 500) {
      showError('服务端没有配置凭据（USERNAME / PASSWORD），请先在部署端设置。');
      return;
    }
    showError(`登录失败：${error.message}`);
  }
});

// 已登录就不必再看这张表单
api
  .session()
  .then((session) => {
    if (session.authenticated) location.replace(nextUrl);
  })
  .catch(() => {
    /* 探测失败不阻塞登录 */
  });

usernameInput.focus();
