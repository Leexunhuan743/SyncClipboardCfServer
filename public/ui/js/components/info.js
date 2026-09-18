// 部署信息对话框：把「客户端该填什么地址」这类问题在这里一次说清。
// 这不是装饰——自建服务器的第一个卡点就是服务器地址到底填不填尾斜杠、要不要带 /dav。
import { el, svg } from '../dom.js';
import { iconPaths } from '../icons.js';
import { setPending, flashSuccess, isPending } from './toast.js';

function row(label, value, { mono = false } = {}) {
  return el('div', { class: 'field' }, [
    el('span', { class: 'eyebrow', text: label }),
    mono ? el('span', { class: 'mono', text: value }) : el('span', { text: value }),
  ]);
}

export function createInfo({ onCopyText }) {
  const title = el('h2', { class: 'dialog__title', id: 'info-title', text: '部署信息' });
  const body = el('div', { class: 'dialog__body' });

  const dialog = el('dialog', { class: 'dialog', 'aria-labelledby': 'info-title' }, [
    el('div', { class: 'dialog__head' }, [
      title,
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': '关闭', onclick: () => dialog.close() }, [
        svg(iconPaths('close')),
      ]),
    ]),
    body,
  ]);
  // 点背景关闭（点击落在 dialog 自身而不是其内容上）
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  document.body.append(dialog);

  // 复制按钮：成功就地显示「已复制」，而不是只弹一条提示（提示条会和其他消息互相顶掉）
  function copyButton(getText, label) {
    const button = el(
      'button',
      {
        class: 'btn',
        type: 'button',
        onclick: async () => {
          if (isPending(button)) return;
          setPending(button, true);
          try {
            if (await onCopyText(getText(), label)) flashSuccess(button, { label: '已复制' });
          } finally {
            setPending(button, false);
          }
        },
      },
      [svg(iconPaths('copy'), { size: 15 }), el('span', { class: 'btn__label', text: '复制' })],
    );
    return button;
  }

  return {
    open(info) {
      if (!info) {
        body.replaceChildren(el('p', { text: '暂时取不到部署信息。' }));
        dialog.showModal();
        return;
      }

      const urlInput = el('input', { class: 'input', type: 'text', readonly: true, value: info.serverUrl });
      urlInput.id = 'server-url';
      urlInput.addEventListener('focus', () => urlInput.select());
      urlInput.addEventListener('click', () => urlInput.select());

      const retention = info.retention ?? {};
      const counts = info.counts ?? {};
      const byType = counts.byType ?? {};
      const transports = (info.hubTransports ?? []).map((entry) => entry.transport).join(' · ');
      const fileSizeMB = info.storage?.totalFileSizeMB ?? 0;

      body.replaceChildren(
        el('div', { class: 'field' }, [
          el('label', { class: 'eyebrow', for: 'server-url', text: 'SyncClipboard 客户端的「服务器地址」' }),
          el('div', { class: 'toolbar__group' }, [urlInput, copyButton(() => info.serverUrl, '服务器地址')]),
          el('span', {
            class: 'auth__note',
            text: '账户与密码和服务端一致（即部署时设置的 USERNAME / PASSWORD）。登出只清除本机 Cookie，不会使已泄露的会话令牌失效；要立即撤销，只能改口令。',
          }),
        ]),
        el('hr', { style: { border: '0', borderTop: '1px solid var(--border)', margin: '16px 0' } }),
        row('服务端版本', info.version ?? '—'),
        row('实时推送传输', transports || '—'),
        row(
          '保留策略',
          retention.retentionMinutes
            ? `${Math.round(retention.retentionMinutes / 1440)} 天（上限 ${retention.maxSavedHistoryCount ?? '不限'} 条）；已删除的记录再保留 30 天后彻底清除`
            : '服务端未设置',
        ),
        row(
          '数据体积',
          `${fileSizeMB} MB（总计 ${counts.total ?? 0} 条，活跃 ${counts.active ?? 0} 条，已删除 ${counts.deleted ?? 0} 条）`,
        ),
        row(
          '按类型',
          `文本 ${byType.Text ?? 0} · 图片 ${byType.Image ?? 0} · 文件 ${byType.File ?? 0} · 组合 ${byType.Group ?? 0}`,
        ),
      );

      dialog.showModal();
    },
  };
}
