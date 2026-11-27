import type { CSSProperties, ReactNode } from 'react';
import { storage } from '../lib/api';
import { isTeacher, useAuth } from '../lib/auth';
import { useNotifications } from '../lib/notifications';
import { Link, navigate } from '../lib/router';
import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from './Icon';
import { Logo } from './Logo';
import { IconButton, setReduceFx } from './ui';

const NAV_KEY = 'mam.nav';

type NavItem = { to: string; label: string; icon: IconName; match: string };
type NavGroup = { title?: string; items: NavItem[] };

const STUDENT: NavItem[] = [
  { to: '/learn', label: 'Học', icon: 'home', match: '/learn' },
  { to: '/coach', label: 'Trợ lý học tập', icon: 'sparkle', match: '/coach' },
  { to: '/flashcards', label: 'Thẻ ghi nhớ', icon: 'copy', match: '/flashcards' },
  { to: '/profile', label: 'Hồ sơ', icon: 'user', match: '/profile' },
  { to: '/forum', label: 'Diễn đàn', icon: 'note', match: '/forum' },
  { to: '/messages', label: 'Tin nhắn', icon: 'chat', match: '/messages' },
  { to: '/inbox', label: 'Thông báo', icon: 'bell', match: '/inbox' },
];
const TEACHING: NavItem[] = [
  { to: '/teach/courses', label: 'Khóa học', icon: 'list', match: '/teach/courses' },
  { to: '/teach/videos', label: 'Video', icon: 'video', match: '/teach/videos' },
  { to: '/teach/docs', label: 'Học liệu', icon: 'book', match: '/teach/docs' },
  { to: '/teach/questions', label: 'Ngân hàng câu hỏi', icon: 'question', match: '/teach/questions' },
  { to: '/teach/flashcards', label: 'Thẻ ghi nhớ', icon: 'copy', match: '/teach/flashcards' },
];
const USERS_PAGE = { to: '/teach/users', icon: 'users' as IconName, match: '/teach/users' };
const RESULTS: NavItem = { to: '/teach/submissions', label: 'Kết quả kiểm tra', icon: 'chart', match: '/teach/submissions' };
const TALK: NavItem[] = STUDENT.filter((n) => ['/forum', '/messages', '/inbox'].includes(n.to));
const ADMIN_EXTRA: NavItem[] = [
  { to: '/teach/eval', label: 'Đánh giá Tutor AI', icon: 'check', match: '/teach/eval' },
  { to: '/admin/system', label: 'Hệ thống', icon: 'settings', match: '/admin' },
];

/** Menu theo vai trò. Giáo viên/admin không thấy nhóm học sinh (xem thử qua "Xem trang học sinh" ở menu tài khoản). */
function navGroups(role: string | undefined): NavGroup[] {
  if (role === 'admin') return [
    { title: 'Giảng dạy', items: TEACHING },
    { title: 'Lớp học', items: [RESULTS] },
    { title: 'Trao đổi', items: TALK },
    { title: 'Quản trị', items: [{ ...USERS_PAGE, label: 'Người dùng & lớp' }, ...ADMIN_EXTRA] },
  ];
  if (role === 'teacher') return [
    { title: 'Giảng dạy', items: TEACHING },
    { title: 'Lớp học', items: [{ ...USERS_PAGE, label: 'Học sinh & lớp' }, RESULTS] },
    { title: 'Trao đổi', items: TALK },
  ];
  return [
    { title: 'Học tập', items: STUDENT.filter((n) => ['/learn', '/coach', '/flashcards', '/profile'].includes(n.to)) },
    { title: 'Lớp học', items: [{ to: '/classes', label: 'Lớp của tôi', icon: 'school', match: '/classes' }, ...TALK] },
  ];
}

export function AppShell({ path, children, aside }: { path: string; children: ReactNode; aside?: ReactNode }) {
  const { user, logout } = useAuth();
  const teacher = isTeacher(user);
  const [reduceFx, setReduce] = useState(() => document.documentElement.classList.contains('reduce-fx'));
  const toggleFx = () => { setReduce(!reduceFx); setReduceFx(!reduceFx); };
  const noti = useNotifications();
  // Giữ lựa chọn thu gọn hoặc mở rộng khi chuyển trang.
  const [navPref, setNavPref] = useState(() => storage.get(NAV_KEY));
  const compact = navPref === 'mini';
  const toggleNav = () => { const next = compact ? 'full' : 'mini'; storage.set(NAV_KEY, next); setNavPref(next); };
  const groups = navGroups(teacher ? user?.role : 'student');
  // số mục menu: CSS chia chiều cao màn hình cho đủ hiện hết, không phải cuộn (mỗi tiêu đề nhóm tính ~0.6 mục)
  const navCount = groups.reduce((n, g) => n + g.items.length + (g.title ? 0.6 : 0), 0);
  const badge: Record<string, number> = { '/forum': noti?.forum_new || 0, '/messages': noti?.dm_unread || 0, '/inbox': noti?.inbox_unread || 0 };
  const nav = (items: NavItem[]) => items
    .map((n) => (
      <Link key={n.to} to={n.to} className={`nav-item ${path.startsWith(n.match) ? 'nav-on' : ''}`}
        aria-current={path.startsWith(n.match) ? 'page' : undefined} title={compact ? n.label : undefined}>
        <Icon name={n.icon} size={26} />
        <span>{n.label}</span>
        {!!badge[n.to] && <span className="nav-badge" aria-label={`${badge[n.to]} mới`}>{badge[n.to] > 99 ? '99+' : badge[n.to]}</span>}
      </Link>
    ));
  return (
    <div className={`shell ${compact ? 'shell-compact' : ''}`}>
      <nav className="sidenav" aria-label="Điều hướng chính" style={{ '--nav-n': navCount } as CSSProperties}>
        <div className="sidenav-top">
          <Link to={teacher && !path.startsWith('/learn') && !path.startsWith('/profile') && !path.startsWith('/settings') ? '/teach/courses' : '/learn'} className="sidenav-logo" aria-label="Trang chủ"><Logo size={34} /></Link>
          <IconButton icon={compact ? 'chevronRight' : 'chevronLeft'} label={compact ? 'Mở rộng menu' : 'Thu gọn menu'} onClick={toggleNav} className="sidenav-toggle" />
        </div>
        {groups.map((g, i) => (
          <div key={g.title || i} className="sidenav-group">
            {g.title && <span className="sidenav-title">{g.title}</span>}
            {nav(g.items)}
          </div>
        ))}
        <UserMenu name={user?.name || user?.user_id || ''} teacher={teacher} studentView={['/learn', '/coach', '/profile', '/flashcards'].some((p) => path.startsWith(p))}
          role={`${user?.role === 'student' ? 'Học sinh' : user?.role === 'teacher' ? 'Giáo viên' : 'Quản trị'}${user?.class_ids?.length ? ` · ${user.class_ids.join(', ')}` : ''}`}
          compact={compact} settingsOn={path.startsWith('/settings')} reduceFx={reduceFx} onToggleFx={toggleFx} onLogout={() => logout()} />
      </nav>
      <main className="shell-main">{children}</main>
      {aside && <aside className="shell-aside">{aside}</aside>}
    </div>
  );
}

/** Góc dưới menu: chỉ hiện avatar + tên; bấm vào mới mở các nút Cài đặt / Hiệu ứng / Đăng xuất. */
function UserMenu({ name, role, compact, settingsOn, reduceFx, onToggleFx, onLogout, teacher, studentView }: {
  name: string; role: string; compact: boolean; settingsOn: boolean; reduceFx: boolean; onToggleFx: () => void; onLogout: () => void;
  teacher: boolean; studentView: boolean;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);
  const pick = (fn: () => void) => () => { setOpen(false); fn(); };
  return (
    <div className="sidenav-user" ref={box}>
      <button type="button" className={`user-chip ${open ? 'on' : ''}`} onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}
        title={compact ? name : undefined}>
        <span className="avatar" aria-hidden="true">{(name || '?').slice(0, 1).toUpperCase()}</span>
        <span className="sidenav-user-text"><strong>{name}</strong><span>{role}</span></span>
        <Icon name="chevronDown" size={16} className="user-chip-caret" />
      </button>
      {open && (
        <div className="user-menu" role="menu">
          <div className="user-menu-head"><strong>{name}</strong><span>{role}</span></div>
          {teacher && (studentView ? (
            <button type="button" role="menuitem" onClick={pick(() => navigate('/teach/courses'))}>
              <Icon name="list" size={18} /> Về trang giáo viên
            </button>
          ) : (
            <button type="button" role="menuitem" onClick={pick(() => navigate('/learn'))}>
              <Icon name="home" size={18} /> Xem trang học sinh
            </button>
          ))}
          <button type="button" role="menuitem" className={settingsOn ? 'on' : ''} onClick={pick(() => navigate('/settings'))}>
            <Icon name="settings" size={18} /> Cài đặt
          </button>
          <button type="button" role="menuitem" onClick={pick(onToggleFx)}>
            <Icon name="sparkle" size={18} /> {reduceFx ? 'Bật hiệu ứng' : 'Giảm hiệu ứng'}
          </button>
          <button type="button" role="menuitem" className="danger" onClick={pick(onLogout)}>
            <Icon name="logout" size={18} /> Đăng xuất
          </button>
        </div>
      )}
    </div>
  );
}

export function PageHeader({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="muted">{sub}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}
