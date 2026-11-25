# D04N Mobile

App điện thoại **mầm** (Android / iOS) cho **học sinh** và **giáo viên**, viết bằng React Native + [Expo](https://expo.dev) (SDK 58).
App dùng chung backend FastAPI trong `ai-backend/`, không có server riêng. Giao diện bám theo bản web: tông đỏ đô, chữ Bricolage Grotesque, logo mầm, thẻ trắng bo tròn.

Bản điện thoại là bản rút gọn. Những việc soạn nội dung và quản trị vẫn làm trên web.

| | Có trên app | Chỉ có trên web |
|---|---|---|
| Học sinh | Đăng nhập, trang học (XP, chuỗi ngày), khoá học → bài học, video có phụ đề + câu hỏi của giáo viên trong video, bài đọc, slide (dạng chữ), bài kiểm tra, ôn thẻ ghi nhớ, Trợ lý học tập (có lịch sử), thông báo, vào lớp bằng mã, đổi mật khẩu | Diễn đàn đầy đủ (đăng bài, ảnh), tin nhắn riêng, Tutor bên cạnh bài học, câu hỏi mở rộng do AI tự đặt trong video, ghi chú, bảng xếp hạng |
| Giáo viên | Tiến độ lớp (ai đạt, ai chưa làm bài kiểm tra), diễn đàn lớp (đọc, trả lời, chọn lời giải, AI soạn nháp trả lời), duyệt / từ chối câu hỏi | Soạn khoá học, tải video / tài liệu, AI soạn câu hỏi, sửa câu hỏi, xuất đề, quản lý học sinh & lớp, đánh giá RAG, trang hệ thống |

Tài khoản quản trị đăng nhập app sẽ thấy giao diện giáo viên.

---

## Chạy thử bằng Expo Go (không cần Android Studio / Xcode)

Cần: Node.js 20+ trên máy tính, điện thoại cài app **Expo Go** (CH Play / App Store), điện thoại và máy tính **cùng một mạng Wi-Fi**.

**1. Chạy backend cho máy khác trong mạng truy cập được** (từ thư mục gốc repo):

```powershell
.\scripts\run.ps1 -Lan        # Windows
./scripts/run.sh --lan        # macOS / Linux
```

Backend phải chạy trên cùng máy với Expo: app tự tìm địa chỉ máy đó và gọi cổng 8000.
Lần đầu Windows hỏi tường lửa cho Python: chọn **Cho phép** với mạng Private.

**2. Chạy app:**

```powershell
cd mobile
npm install
npm start
```

Terminal hiện mã QR. Android: mở Expo Go → *Scan QR code*. iPhone: mở app Camera quét mã.
Trên iPhone, Expo Go chỉ mở dự án khi máy tính đã chạy `npx expo login` và Expo Go đăng nhập cùng tài khoản.

**3. Trên điện thoại:** đăng nhập bằng tài khoản demo (`sv-01` hoặc `gv-demo`, mật khẩu `Demo@2026`
nếu đã chạy `init_db.py --seed`). Không cần nhập địa chỉ máy chủ.

Nếu backend chạy ở máy khác: đặt `EXPO_PUBLIC_API_URL=http://192.168.1.10:8000 npm start`, hoặc khi gặp lỗi kết nối
bấm *Đổi máy chủ* ở màn đăng nhập. Bản build (APK) dùng `expo.extra.apiUrl` trong `app.json` hoặc `EXPO_PUBLIC_API_URL` lúc build.

### Gặp lỗi

- **"Không kết nối được máy chủ"**: kiểm tra cùng Wi-Fi, backend chạy với `-Lan`, tường lửa cho phép Python, mở thử `http://<IP>:8000/health` bằng trình duyệt điện thoại.
- **Wi-Fi trường / quán cà phê chặn các máy nhìn thấy nhau**: dùng `npm run tunnel` cho app, và đưa backend lên một địa chỉ công khai (máy chủ đã deploy hoặc một tunnel như ngrok / Cloudflare Tunnel), rồi đặt địa chỉ `https://...` đó qua `EXPO_PUBLIC_API_URL` (hoặc *Đổi máy chủ* trên điện thoại).
- **Expo Go báo "SDK version not supported"**: cập nhật Expo Go lên bản mới nhất (app dùng SDK 58).

---

## Cấu trúc thư mục

```
mobile/
├── app.json                 # cấu hình Expo (tên app, icon, plugin)
├── src/
│   ├── app/                 # màn hình, mỗi file là một route (Expo Router)
│   │   ├── _layout.tsx      # gốc: đăng nhập → chia nhánh học sinh / giáo viên
│   │   ├── login.tsx
│   │   ├── (student)/       # tab học sinh: Học, Ôn thẻ, Trợ lý, Thông báo, Tôi
│   │   ├── (teacher)/       # tab giáo viên: Lớp học, Diễn đàn, Duyệt câu, Thông báo, Tôi
│   │   ├── course/[id].tsx  # chương → bài
│   │   ├── lesson/[id].tsx  # danh sách mục trong bài
│   │   ├── item/[id].tsx    # một mục: video / bài đọc / slide / kiểm tra
│   │   ├── flashcards/[code].tsx
│   │   ├── coach/[id].tsx   # chat với Trợ lý ("new" = cuộc mới)
│   │   └── forum/[id].tsx   # một bài trên diễn đàn
│   ├── components/          # ui.tsx (nút, thẻ, ...), Markdown, items/ (Video, Quiz, ...)
│   └── lib/                 # api.ts (gọi backend), auth.tsx, theme.ts (màu), hooks
```

App gọi đúng các API `/ai/*` mà bản web dùng, nên khi backend đổi API thì sửa cả `frontend/src` và `mobile/src`.
Kiểu dữ liệu trong `src/lib/api.ts` chép từ `frontend/src/lib/api.ts`.

## Lệnh hữu ích

```bash
npm run typecheck            # kiểm tra kiểu TypeScript
npx expo install <gói>       # thêm thư viện (tự chọn phiên bản hợp với SDK 58)
npx expo-doctor              # kiểm tra cấu hình và phiên bản thư viện
```

Chỉ dùng thư viện có sẵn trong Expo Go (xem danh sách trong tài liệu Expo SDK 58) để giữ được cách chạy thử bằng Expo Go.
## Xuất file APK (Android)

Dùng EAS Build: Expo build trên máy chủ của họ, không cần Android Studio. Cấu hình có sẵn trong `eas.json`.

```powershell
cd mobile
npx eas-cli login                                   # tài khoản Expo miễn phí (expo.dev)
npx eas-cli build -p android --profile preview      # lần đầu hỏi tạo project + khoá ký: chọn Yes
```

Khoảng 10–20 phút sau, terminal và trang expo.dev hiện link tải `.apk`. Gửi link (hoặc mã QR) cho ai cũng cài được trên Android
(cho phép "Cài ứng dụng không rõ nguồn gốc" khi máy hỏi). Gói miễn phí có giới hạn số lượt build mỗi tháng, đủ cho đồ án.

App đã cho phép kết nối `http://` (cấu hình `usesCleartextTraffic` trong `app.json`) nên bản `.apk` vẫn dùng được với backend chạy
trong mạng Wi-Fi nội bộ khi demo. Khi có máy chủ thật thì nên dùng địa chỉ `https://`.

Bản `production` (file `.aab`) chỉ cần khi đưa lên Google Play.
