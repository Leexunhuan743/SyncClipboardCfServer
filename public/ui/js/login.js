// 登录页：一个表单、一处错误位、一个 pending 态。
import { api, ApiError } from './api.js';
import { resolveNext } from './next-target.js';

const form = document.getElementById('login-form');
const errorBox = document.getElementById('login-error');
const submit = document.getElementById('login-submit');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');

// `?next=` 只在**同源**时才用作跳转目标（判定实现见 next-target.js：前缀比较挡不住
// `/\evil.example` 这类反斜杠变体）。解析失败或跨源一律回落站内默认页。
const nextUrl = resolveNext(new URLSearchParams(location.search).get('next'), location.origin) ?? '/ui/';

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
