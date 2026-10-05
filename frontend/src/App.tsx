import { useEffect, type ReactElement } from 'react';
import { AppShell } from './components/AppShell';
import { isTeacher, useAuth } from './lib/auth';
import { match, navigate, useLocation } from './lib/router';
import { Learn } from './pages/Learn';
import { LessonPage } from './pages/Lesson';
import { ForceChangePassword, Login } from './pages/Login';
import { Profile } from './pages/Profile';
import { CourseEditor, Courses } from './pages/teach/Courses';
import { Documents } from './pages/teach/Documents';
import { Evaluation } from './pages/teach/Evaluation';
import { QuestionBank } from './pages/teach/QuestionBank';
import { System } from './pages/teach/System';
import { Users } from './pages/teach/Users';
import { VideoDetail, Videos } from './pages/teach/Videos';

export function App() {
  const path = useLocation();
  const { user } = useAuth();

  useEffect(() => {
    if (!user && path !== '/login') navigate('/login', true);
    else if (user && (path === '/' || path === '/login')) navigate(isTeacher(user) ? '/teach/courses' : '/learn', true);
  }, [user, path]);

  if (!user) return <Login />;
  if (user.must_change_password) return <ForceChangePassword />;

  let m: Record<string, string> | null;
  if ((m = match('/lesson/:lessonId/:itemId?', path))) return <LessonPage lessonId={m.lessonId} itemId={m.itemId} />;

  const teacherOnly = (el: ReactElement) => (isTeacher(user) ? el : <Learn path={path} />);

  let page: ReactElement;
  if ((m = match('/learn/:courseId?', path))) page = <Learn path={path} courseId={m.courseId} />;
  else if (match('/profile', path)) page = <Profile />;
  else if (match('/teach/courses', path)) page = teacherOnly(<Courses />);
  else if ((m = match('/teach/courses/:courseId', path))) page = teacherOnly(<CourseEditor courseId={m.courseId} />);
  else if (match('/teach/videos', path)) page = teacherOnly(<Videos />);
  else if ((m = match('/teach/videos/:videoId', path))) page = teacherOnly(<VideoDetail videoId={m.videoId} />);
  else if (match('/teach/questions', path)) page = teacherOnly(<QuestionBank />);
  else if (match('/teach/docs', path)) page = teacherOnly(<Documents />);
  else if (match('/teach/eval', path)) page = teacherOnly(<Evaluation />);
  else if (match('/teach/users', path)) page = teacherOnly(<Users />);
  else if (match('/admin/system', path)) page = user.role === 'admin' ? <System /> : <Learn path={path} />;
  else page = <Learn path={path} />;

  // Trang Learn tự dựng AppShell (có cột phải)
  if (page.type === Learn) return page;
  return <AppShell path={path}>{page}</AppShell>;
}
