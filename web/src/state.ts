// 应用状态：一个朴素的可变对象，由控制器（app.ts）改、由视图读。
// 视图都是 `render(state)` 形状的幂等函数：同一份 state 渲染多少次结果都一样，
// 所以"哪里该更新"这件事交给各视图自己对账，而不是在这里发明订阅图。
import type { ActivityDay, Filters, Item, Overview, PushState } from './lib/types';

export type Density = 'comfortable' | 'compact';

export interface AppState {
  user: string;
  filters: Filters;
  items: Item[];
  total: number;
  /** 首次加载 / 加载失败 / 就绪。后续刷新不回到 'loading'（旧结果留着，只标 busy） */
  status: 'loading' | 'ready' | 'error';
  busy: boolean;
  error: string | null;
  overview: Overview | null;
  activity: ActivityDay[] | null;
  selection: ReadonlySet<string>;
  /** 键盘焦点所在的卡片 */
  activeKey: string | null;
  /** 详情面板里打开的记录 */
  openKey: string | null;
  push: PushState;
  /** 服务端时间 − 本机时间（毫秒）；官方客户端在 >5 分钟时会中止历史同步 */
  skewMs: number | null;
  /** 轮询/请求连续失败：界面显示"连接中断" */
  stale: boolean;
  density: Density;
  navOpen: boolean;
  /** 滚离顶部时后台又进来的新记录数（显示「↑ N 条新记录」） */
  fresh: number;
}

export function createState(filters: Filters, density: Density): AppState {
  return {
    user: '',
    filters,
    items: [],
    total: 0,
    status: 'loading',
    busy: false,
    error: null,
    overview: null,
    activity: null,
    selection: new Set(),
    activeKey: null,
    openKey: null,
    push: 'offline',
    skewMs: null,
    stale: false,
    density,
    navOpen: false,
    fresh: 0,
  };
}

/** 侧栏的"当前视图"：类型库 / 收藏 / 收藏夹 / 回收站四选一。 */
export type NavView = { kind: 'type'; type: Filters['types'] } | { kind: 'starred' } | { kind: 'folder'; id: number } | { kind: 'trash' };

export function currentNav(filters: Filters): NavView {
  if (filters.deleted) return { kind: 'trash' };
  if (filters.folder !== null) return { kind: 'folder', id: filters.folder };
  if (filters.starred) return { kind: 'starred' };
  return { kind: 'type', type: filters.types };
}

export function findItem(state: AppState, key: string | null): Item | undefined {
  return key === null ? undefined : state.items.find((item) => item.key === key);
}
