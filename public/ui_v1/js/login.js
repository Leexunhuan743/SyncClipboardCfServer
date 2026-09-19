// 登录页：一个表单、一处错误位、一个 pending 态。
import { api, ApiError, rateLimitMessage, PAGE_BASE } from './api.js';
import { resolveNext } from './next-target.js';

// ===== 文档级幂等守卫（2026-09-18 补）=====
// 应用被以两个 URL 同时加载时，模块图里会出现**两份**同一模块（`docs/ui.md` 记过这个场景，
// 实测触发过），于是本模块被求值两次：下面那个 `submit`
// 监听器再绑一次 ⇒ **一次提交打两次 `POST /ui/api/login`**（第二次带着已被消费的凭据，
// 用户看到的是"用户名或密码不正确"，而其实是重复提交）。列表页一直在守这件事
// （`main.js` 的 `dataset.appBooted`），登录页此前完全没有等价守卫 ——
// 见 `docs/AUDIT-v1-v2-divergence.md` §4.1。
// 重复的那一份仍会求值（ES 模块顶层不能 `return`），但**不再产生任何副作用**。
const APP_ROOT = document.documentElement;
const DUPLICATE_EVAL = APP_ROOT.dataset.appBooted === '1';
APP_ROOT.dataset.appBooted = '1';

const form = document.getElementById('login-form');
const errorBox = document.getElementById('login-error');
const submit = document.getElementById('login-submit');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');

// `?next=` 只在**同源**时才用作跳转目标（判定实现见 next-target.js：前缀比较挡不住
// `/\evil.example` 这类反斜杠变体）。解析失败或跨源一律回落站内默认页。
const nextUrl = resolveNext(new URLSearchParams(location.search).get('next'), location.origin) ?? `${PAGE_BASE}/`;

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

async function submitLogin(event) {
  event.preventDefault();
  // 重入守卫（2026-09-18 补）：`setLoading(true)` 会把按钮 `disabled`，但那挡不住**已经派发
  // 出去**的第二次 submit（双击、按住回车重复触发、或模块被求值两次而绑了两份监听器）。
  // V2 的 `ui/login.js` 一直是 `if (submit.hasAttribute('data-loading')) return;` ——
  // 这道防线 V1 此前没有（`docs/AUDIT-v1-v2-divergence.md` §4.1）。
  if (submit.dataset.loading === 'true') return;

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
}

if (!DUPLICATE_EVAL) {
  form.addEventListener('submit', submitLogin);

  // 已登录就不必再看这张表单（探测失败不阻塞登录；重复求值的那一份不再多发一次请求）
  api
    .session()
    .then((session) => {
      if (session.authenticated) location.replace(nextUrl);
    })
    .catch(() => {
      /* 探测失败不阻塞登录 */
    });

  usernameInput.focus();
}
