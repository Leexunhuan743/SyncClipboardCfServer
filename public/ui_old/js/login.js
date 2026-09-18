// 登录页：一个表单、一处错误位、一个 pending 态。
import { api, ApiError, rateLimitMessage } from './api.js';
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

// 错误必须**挂在出错的那个字段上**（`aria-invalid` + `aria-describedby`）并把焦点交回去 ——
// 这是 `components.md` §2 状态矩阵里 error 那一格的要求（"message adjacent to the control,
// aria-describedby, never colour alone"）。V2 的登录页本来就这么做，V1 此前只写了一个错误框：
// 读屏用户听到一句"用户名或密码不正确"，却不知道是哪个框要改。
//
// `invalid` 单独一个参数：服务端的 500（没配凭据）与 429（限速）不是"这个字段填错了"，
// 标 `aria-invalid` 会撒谎 —— 但焦点仍然交给密码框（用户下一步最可能的动作是重填）。
function showError(message, field = passwordInput, invalid = true) {
  errorBox.textContent = message;
  errorBox.hidden = false;
  if (invalid) field.setAttribute('aria-invalid', 'true');
  field.setAttribute('aria-describedby', 'login-error');
  field.focus();
  field.select();
}

function clearError() {
  errorBox.hidden = true;
  errorBox.textContent = '';
  for (const field of [usernameInput, passwordInput]) {
    field.removeAttribute('aria-invalid');
    field.removeAttribute('aria-describedby');
  }
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
    showError('请输入用户名和密码。', username ? passwordInput : usernameInput);
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
      return;
    }
    if (error instanceof ApiError && error.status === 500) {
      showError('服务端没有配置凭据（USERNAME / PASSWORD），请先在部署端设置。', passwordInput, false);
      return;
    }
    // 429 = 认证失败限速（src/rateLimit.ts：15 分钟内失败 10 次就封锁 15 分钟）。
    // 服务端的响应体是纯文本，`statusText` 是英文的 "Too Many Requests" —— 直接端出去
    // 用户既看不懂原因、也不知道要等多久，故这里翻译成中文并带上 Retry-After。
    if (error instanceof ApiError && error.status === 429) {
      showError(rateLimitMessage(error), passwordInput, false);
      return;
    }
    showError(`登录失败：${error.message}`, passwordInput, false);
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
