// 登录页：唯一任务是让用户尽快离开它。
//
// 与列表页共享令牌与控件（`tokens-v2.css` / `base-v2.css` / `overlay-v2.css` 的 `.auth*`），
// 只有版式不同 —— 独立的一张样式表会带来第二个需要保持同步的调色板副本。
import { api, ApiError } from './api.js';
import { resolveNext } from './next-target.js';

// ===== 文档级幂等守卫（2026-09-18 补）=====
// 应用被以两个 URL 同时加载时，模块图里会出现两份同一模块 ⇒ 本模块被求值两次：`passwordToggle`
// 的点击监听、`form` 的 `input` 监听各再绑一次，会话探测也再发一次请求。
// 本页**不会**因此重复提交（`submit` 上有 `data-loading` 早退），但重复的监听器与多余的一次
// 往返没有理由留着 —— 列表页守在 `boot.js` 的 `dataset.appBooted`，登录页补上同一条。
// 见 `docs/archive/AUDIT-v1-v2-divergence.md` §4.1（V1 的登录页缺的是更强的两条，已一并补）。
// 重复的那一份仍会求值（ES 模块顶层不能 `return`），但**不再产生任何副作用**。
const APP_ROOT = document.documentElement;
const DUPLICATE_EVAL = APP_ROOT.dataset.appBooted === '1';
APP_ROOT.dataset.appBooted = '1';

const form = document.getElementById('login-form');
const userInput = document.getElementById('username');
const passInput = document.getElementById('password');
const submit = document.getElementById('login-submit');
const errorBox = document.getElementById('login-error');
const passwordToggle = document.getElementById('password-toggle');

/** 错误文案：区分"凭据错"与"服务端没配凭据"，两者的处理方式完全不同。 */
function messageFor(error) {
  if (error instanceof ApiError) {
    if (error.status === 401) return '用户名或密码不对。';
    if (error.status === 500) {
      // 服务端未配置凭据时给的是可诊断的 500 —— 照抄给用户，别翻译成"服务器错误"
      return '服务器暂时无法登录，请联系管理员检查服务与账号配置。';
    }
    if (error.status === 400) return '请求格式不对，请重试。';
    if (error.status === 429) return '尝试次数过多，请稍后再试。';
    return `登录失败：${error.message}`;
  }
  return `登录失败：${error?.message ?? '网络错误'}`;
}

function showError(message, field = passInput, invalid = true) {
  errorBox.textContent = message;
  errorBox.hidden = false;
  // 焦点交给出错的那个字段：键盘用户可以立刻改，不必再 Tab 回来
  if (invalid) field.setAttribute('aria-invalid', 'true');
  field.setAttribute('aria-describedby', 'login-error');
  field.focus();
  field.select();
}

function clearError() {
  errorBox.hidden = true;
  errorBox.textContent = '';
  userInput.removeAttribute('aria-invalid');
  passInput.removeAttribute('aria-invalid');
  userInput.removeAttribute('aria-describedby');
  passInput.removeAttribute('aria-describedby');
}

// 提交处理：写成具名函数，才能在下面的守卫里按需接线（见顶部的 `DUPLICATE_EVAL`）。
async function submitLogin(event) {
  event.preventDefault();
  if (submit.hasAttribute('data-loading')) return;

  const username = userInput.value.trim();
  const password = passInput.value;
  clearError();
  if (!username || !password) {
    showError(!username ? '请填写用户名。' : '请填写密码。', !username ? userInput : passInput);
    return;
  }

  submit.setAttribute('data-loading', '');
  submit.setAttribute('aria-busy', 'true');
  submit.disabled = true;

  try {
    await api.login(username, password);
    // `?next=` 只接受**同源**目标（纯函数 `resolveNext` 负责判定）：
    // 前缀比较不够 —— 浏览器对 http/https 这类 special scheme 把 `\` 视同 `/`，
    // 于是 `?next=/\evil.example` 与 `//evil.example` 一样会跳到站外。
    const next = resolveNext(new URLSearchParams(location.search).get('next'), location.origin, '/ui_v2/app/');
    location.replace(next);
  } catch (error) {
    submit.removeAttribute('data-loading');
    submit.removeAttribute('aria-busy');
    submit.disabled = false;
    showError(messageFor(error), passInput, error instanceof ApiError && error.status === 401);
  }
}

if (!DUPLICATE_EVAL) {
  form.addEventListener('input', clearError);
  form.addEventListener('submit', submitLogin);
  passwordToggle.addEventListener('click', () => {
    const visible = passInput.type === 'password';
    passInput.type = visible ? 'text' : 'password';
    passwordToggle.textContent = visible ? '隐藏' : '显示';
    passwordToggle.setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
    passwordToggle.setAttribute('aria-pressed', String(visible));
  });

  // 打开页面时：已登录就直接进列表页（登录页出现在已登录状态下是"多一步"）。
  // 这一步失败不报错 —— 会话探测失败与"未登录"对用户而言是同一件事：填表。
  void (async () => {
    try {
      const session = await api.session();
      if (session?.authenticated) {
        const next = resolveNext(
          new URLSearchParams(location.search).get('next'),
          location.origin,
          '/ui_v2/app/',
        );
        location.replace(next);
      }
    } catch {
      /* 忽略：让用户填表 */
    }
  })();

  // 自动聚焦用户名（页面上唯一"下一步"）
  userInput.focus();
}
