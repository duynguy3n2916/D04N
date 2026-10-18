import type { ReactNode } from 'react';
import { isTeacher, useAuth } from '../lib/auth';
import { Link } from '../lib/router';
import { useState } from 'react';
import { Icon, type IconName } from './Icon';
import { Logo } from './Mascot';
import { IconButton, setReduceFx } from './ui';

type NavItem = { to: string; label: string; icon: IconName; match: string; admin?: boolean };

const STUDENT: NavItem[] = [
  { to: '/learn', label: 'Học', icon: 'home', match: '/learn' },
  { to: '/profile', label: 'Hồ sơ', icon: 'user', match: '/profile' },
  { to: '/forum', label: 'Diễn đàn', icon: 'note', match: '/forum' },
];
const TEACHER: NavItem[] = [
  { to: '/teach/courses', label: 'Khóa học', icon: 'list', match: '/teach/courses' },
  { to: '/teach/videos', label: 'Video', icon: 'video', match: '/teach/videos' },
  { to: '/teach/questions', label: 'Câu hỏi', icon: 'question', match: '/teach/questions' },
  { to: '/teach/docs', label: 'Học liệu', icon: 'book', match: '/teach/docs' },
  { to: '/teach/users', label: 'Học sinh & lớp', icon: 'users', match: '/teach/users' },
  { to: '/teach/submissions', label: 'Bài nộp', icon: 'list', match: '/teach/submissions' },
  { to: '/forum', label: 'Diễn đàn', icon: 'note', match: '/forum' },
  { to: '/teach/eval', label: 'Đánh giá', icon: 'chart', match: '/teach/eval' },
  { to: '/admin/system', label: 'Hệ thống', icon: 'settings', match: '/admin', admin: true },
];

export function AppShell({ path, children, aside }: { path: string; children: ReactNode; aside?: ReactNode }) {
  const { user, logout } = useAuth();
  const teacher = isTeacher(user);
  const [reduceFx, setReduce] = useState(() => document.documentElement.classList.contains('reduce-fx'));
  const toggleFx = () => { setReduce(!reduceFx); setReduceFx(!reduceFx); };
  const nav = (items: NavItem[]) => items
    .filter((n) => !n.admin || user?.role === 'admin')
    .map((n) => (
      <Link key={n.to} to={n.to} className={`nav-item ${path.startsWith(n.match) ? 'nav-on' : ''}`}
        aria-current={path.startsWith(n.match) ? 'page' : undefined}>
        <Icon name={n.icon} size={26} />
        <span>{n.label}</span>
      </Link>
    ));
  return (
    <div className="shell">
      <nav className="sidenav" aria-label="Điều hướng chính">
        <Link to={teacher && !path.startsWith('/learn') && !path.startsWith('/profile') ? '/teach/courses' : '/learn'} className="sidenav-logo" aria-label="Trang chủ"><Logo size={48} /></Link>
        <div className="sidenav-group">
          {teacher && <span className="sidenav-title">Học sinh</span>}
          {nav(STUDENT)}
        </div>
        {teacher && (
          <div className="sidenav-group">
            <span className="sidenav-title">{user?.role === 'admin' ? 'Quản trị' : 'Giáo viên'}</span>
            {nav(TEACHER)}
          </div>
        )}
        <div className="sidenav-user">
          <span className="avatar" aria-hidden="true">{(user?.name || user?.user_id || '?').slice(0, 1).toUpperCase()}</span>
          <span className="sidenav-user-text">
            <strong>{user?.name || user?.user_id}</strong>
            <span>{user?.role === 'student' ? 'Học sinh' : user?.role === 'teacher' ? 'Giáo viên' : 'Quản trị'}{user?.class_ids?.length ? ` · ${user.class_ids.join(', ')}` : ''}</span>
          </span>
          <IconButton icon="sparkle" label={reduceFx ? 'Bật hiệu ứng' : 'Giảm hiệu ứng'} active={reduceFx} onClick={toggleFx} />
          <button className="iconbtn" onClick={() => logout()} aria-label="Đăng xuất" title="Đăng xuất"><Icon name="logout" size={20} /></button>
        </div>
      </nav>
      <main className="shell-main">{children}</main>
      {aside && <aside className="shell-aside">{aside}</aside>}
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
