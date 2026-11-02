// 登录页：同一页里的一个状态（不是单独的 HTML），登录成功后原地切到应用。
import { api, ApiError, rateLimitMessage } from '../lib/api';
import { h, icon } from '../lib/dom';
import { getThemeStyle, setThemeStyle, STYLES } from '../theme';

/** 登录页底部的风格小圆点：不用登录就能换风格（也是这套主题系统最直观的展示）。 */
function styleDots(): HTMLElement {
  const wrap = h('div', { class: 'style-dots', role: 'group', 'aria-label': '界面风格' });
  const paint = (): void => {
    const current = getThemeStyle();
    wrap.replaceChildren(
      ...STYLES.map((s) => h('button', { class: 'style-dot', type: 'button', dataset: { style: s.id }, title: s.name, 'aria-label': `风格：${s.name}`, 'aria-pressed': String(s.id === current), onclick: () => { setThemeStyle(s.id); paint(); } })),
    );
  };
  paint();
  return wrap;
}

export function createLogin(onSuccess: (username: string) => void, notice: string | null = null) {
  const user = h('input', { class: 'input input--lg', id: 'login-user', type: 'text', name: 'username', autocomplete: 'username', required: true, autocapitalize: 'none', spellcheck: 'false' });
  const pass = h('input', { class: 'input input--lg', id: 'login-pass', type: 'password', name: 'password', autocomplete: 'current-password', required: true });
  const error = h('p', { class: 'form-error', id: 'login-error', role: 'alert', hidden: true });
  const submit = h('button', { class: 'btn btn--primary btn--lg', type: 'submit' }, h('span', { text: '登录' }));

  const fail = (message: string, field?: HTMLInputElement): void => {
    error.textContent = message;
    error.hidden = false;
    for (const input of [user, pass]) {
      input.removeAttribute('aria-invalid');
      input.removeAttribute('aria-describedby');
    }
    // 只有字段自身不合法才标 aria-invalid：网络/500 不能冒充字段错误
    if (field) {
      field.setAttribute('aria-invalid', 'true');
      field.setAttribute('aria-describedby', 'login-error');
      field.focus();
    }
  };

  const form = h(
    'form',
    { class: 'login__card', novalidate: true },
    notice ? h('p', { class: 'notice', dataset: { tone: 'warn' }, role: 'status' }, icon('warning', { size: 18 }), h('span', { text: notice })) : null,
    h('label', { class: 'field', for: 'login-user' }, h('span', { class: 'field__label', text: '用户名' }), user),
    h('label', { class: 'field', for: 'login-pass' }, h('span', { class: 'field__label', text: '密码' }), pass),
    error,
    submit,
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.hidden = true;
    if (user.value.trim() === '') return fail('请输入用户名。', user);
    if (pass.value === '') return fail('请输入密码。', pass);
    submit.disabled = true;
    submit.dataset.busy = 'true';
    try {
      const result = await api.login(user.value.trim(), pass.value);
      pass.value = '';
      onSuccess(result.username);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) fail('用户名或密码不正确。', pass);
      else if (e instanceof ApiError && e.status === 429) fail(rateLimitMessage(e));
      else if (e instanceof ApiError && e.status === 500) fail('服务器还没有配置登录凭据（USERNAME / PASSWORD）。');
      else fail(e instanceof Error ? `登录失败：${e.message}` : '登录失败，请重试。');
    } finally {
      submit.disabled = false;
      delete submit.dataset.busy;
    }
  });

  const el = h(
    'main',
    { class: 'login' },
    h(
      'div',
      { class: 'login__panel' },
      h('div', { class: 'login__brand' }, h('span', { class: 'brand__mark brand__mark--lg' }, icon('clipboard', { size: 28 })), h('h1', { text: '剪贴板' }), h('p', { text: '登录后查看这台服务器上同步的全部记录' })),
      form,
      styleDots(),
      h('p', { class: 'login__note', text: '凭据与 SyncClipboard 客户端使用的一致（服务端的 USERNAME / PASSWORD）。登录状态保存在本机 Cookie 中，24 小时后过期。' }),
    ),
  );

  return { el, focus: () => user.focus() };
}
