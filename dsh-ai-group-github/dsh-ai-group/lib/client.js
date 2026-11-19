/**
 * AI 群 · Browser 半侧：注册侧栏入口 + 整页，整页里用 iframe 装载 /ai-group/。
 *
 * 这是 classic script（DSH 以 <script> 直接加载），不能有顶层 import/export。
 * id 必须等于包名，否则 DSH 报 "loaded without registering"。
 */
window.__ModuleLoader__.load({
  id: 'dsh-ai-group',
  factory: (require) => {
    const module = { exports: {} };
    const React = require('react');
    const e = React.createElement;

    /** 侧栏图标：两个对话气泡。 */
    function GroupIcon(props) {
      const size = (props && props.size) || 18;
      return e(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        e('path', { d: 'M8.5 17.5 4.5 20v-4.2A6.5 6.5 0 0 1 11 9h2.5a6.5 6.5 0 0 1 6.5 6.5v.5a6.5 6.5 0 0 1-6.5 6.5H8.5Z' }),
        e('path', { d: 'M9 5.5A4.5 4.5 0 0 1 13.5 1H15a4 4 0 0 1 4 4v.5' }),
      );
    }

    /** 整页：一个铺满主区域的 iframe，内部是完全独立的聊天界面。 */
    function GroupPage() {
      return e(
        'div',
        { style: { width: '100%', height: '100%', minHeight: 0, overflow: 'hidden', background: '#0b0d12' } },
        e('iframe', {
          src: window.location.origin + '/ai-group/',
          title: 'AI 群',
          style: { width: '100%', height: '100%', border: '0', display: 'block', background: '#0b0d12' },
          allow: 'clipboard-read; clipboard-write',
        }),
      );
    }

    function apply(ctx) {
      ctx.slots.inject('main', function* () {
        yield ctx.slots.register({ name: 'main', key: 'ai-group' }, GroupPage);
      });
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          { name: 'sidebar.panellist', id: 'ai-group', order: 10, label: () => 'AI 群' },
          GroupIcon,
        ),
      );
    }

    module.exports = { name: 'ai-group', inject: ['slots'], apply };
    return module.exports;
  },
});
