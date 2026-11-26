import { useEffect, type ReactElement } from 'react';
import { AppShell } from './components/AppShell';
import { isTeacher, useAuth } from './lib/auth';
import { match, navigate, useLocation } from './lib/router';
import { Learn } from './pages/Learn';
import { LessonPage } from './pages/Lesson';
import { FlashcardHub, Flashcards } from './pages/Flashcards';
import { Coach } from './pages/Coach';
import { Forum } from './pages/Forum';
import { Inbox } from './pages/Inbox';
import { Messages } from './pages/Messages';
import { ForceChangePassword, Login, ResetPassword } from './pages/Login';
import { Profile, Settings } from './pages/Profile';
import { CourseEditor, Courses } from './pages/teach/Courses';
import { Documents } from './pages/teach/Documents';
import { Evaluation } from './pages/teach/Evaluation';
import { QuestionBank } from './pages/teach/QuestionBank';
import { System } from './pages/teach/System';
import { FlashcardBank } from './pages/teach/FlashcardBank';
import { Submissions } from './pages/teach/Submissions';
import { Users } from './pages/teach/Users';
import { VideoDetail, Videos } from './pages/teach/Videos';

export function App() {
  const path = useLocation();
  const { user } = useAuth();

  useEffect(() => {
    if (match('/reset-password', path)) return; // link đặt lại mật khẩu trong email: mở được khi chưa đăng nhập
    if (!user && path !== '/login') navigate('/login', true);
    else if (user && (path === '/' || path === '/login')) navigate(isTeacher(user) ? '/teach/courses' : '/learn', true);
    else if (user && user.role !== 'admin' && match('/teach/eval', path)) navigate(isTeacher(user) ? '/teach/courses' : '/learn', true);
  }, [user, path]);

  if (match('/reset-password', path)) return <ResetPassword />;
  if (!user) return <Login />;
  if (user.must_change_password) return <ForceChangePassword />;

  let m: Record<string, string> | null;
  if ((m = match('/lesson/:lessonId/:itemId?', path))) return <LessonPage lessonId={m.lessonId} itemId={m.itemId} />;
  if ((m = match('/flashcards/:lessonCode', path))) return <AppShell path={path}><Flashcards lessonCode={m.lessonCode} /></AppShell>;
  if ((m = match('/forum/:threadId', path))) return <AppShell path={path}><Forum threadId={m.threadId} /></AppShell>;
  if ((m = match('/messages/:conversationId?', path))) return <AppShell path={path}><Messages conversationId={m.conversationId} /></AppShell>;

  const teacherOnly = (el: ReactElement) => (isTeacher(user) ? el : <Learn path={path} />);

  let page: ReactElement;
  if ((m = match('/learn/:courseId?', path))) page = <Learn path={path} courseId={m.courseId} />;
  else if ((m = match('/coach/:conversationId?', path))) page = <Coach conversationId={m.conversationId} />;
  else if (match('/flashcards', path)) page = <FlashcardHub />;
  else if (match('/profile', path)) page = <Profile />;
  else if (match('/settings', path)) page = <Settings />;
  else if (match('/forum', path)) page = <Forum />;
  else if (match('/inbox', path)) page = <Inbox />;
  else if (match('/teach/courses', path)) page = teacherOnly(<Courses />);
  else if ((m = match('/teach/courses/:courseId', path))) page = teacherOnly(<CourseEditor courseId={m.courseId} />);
  else if (match('/teach/videos', path)) page = teacherOnly(<Videos />);
  else if ((m = match('/teach/videos/:videoId', path))) page = teacherOnly(<VideoDetail videoId={m.videoId} />);
  else if (match('/teach/questions', path)) page = teacherOnly(<QuestionBank />);
  else if (match('/teach/docs', path)) page = teacherOnly(<Documents />);
  else if (match('/teach/submissions', path)) page = teacherOnly(<Submissions />);
  else if (match('/teach/flashcards', path)) page = teacherOnly(<FlashcardBank />);
  // Đánh giá Tutor AI chỉ admin chạy được; người khác được chuyển hướng (xem useEffect ở trên)
  else if (match('/teach/eval', path)) page = user.role === 'admin' ? <Evaluation /> : teacherOnly(<Courses />);
  else if (match('/teach/users', path)) page = teacherOnly(<Users />);
  else if (match('/admin/system', path)) page = user.role === 'admin' ? <System /> : <Learn path={path} />;
  else page = <Learn path={path} />;

  // Trang Learn tự dựng AppShell (có cột phải)
  if (page.type === Learn) return page;
  return <AppShell path={path}>{page}</AppShell>;
}
