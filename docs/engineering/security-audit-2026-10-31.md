# Kiểm tra bảo mật khi tải video – 31/10/2026

**Trạng thái: Một phần.** Đã kiểm mã nguồn và tái hiện bằng test trên bản sao cục bộ. Chưa thử trên Chrome thật. Không có npm audit (dự án không có `package.json`).

Phạm vi: tiện ích Chrome Video Catcher 1.7.0, từ commit `f70aa45` đến `0d8ede9`, gồm:

- `background.js`, `content.js`, `hook.js`, `lib/*`
- Trình tải (`manager.js`)
- popup, trang Chẩn đoán
- bộ tải YouTube trên máy (`youtube/native-host.cjs`, `locate.cjs`, `setup-youtube.ps1`)

## Mô hình

**Tác nhân:**

- trang web người dùng đang xem (kể cả iframe quảng cáo);
- máy chủ video/CDN;
- renderer của trang bị chiếm (content script chạy trong renderer đó);
- tiện ích khác.

**Tài sản:**

- file lưu trên máy;
- cookie và phiên đăng nhập (Trình tải gửi request kèm cookie);
- quyền `<all_urls>`;
- chương trình trên máy (yt-dlp, Explorer).

**Bất biến:**

1. Trang web không khiến tiện ích lưu một file chạy được.
2. Trang web không đọc được dữ liệu tiện ích bắt từ tab khác.
3. Trang web không khiến bộ tải trên máy chạy lệnh tuỳ ý hay mở file tuỳ ý.
4. Trang web không làm cạn tài nguyên của tiện ích.

## Bảng phủ

| Mục | Kết quả |
| --- | --- |
| Secret | Đã kiểm: không có file nhạy cảm hay mẫu khoá trong mã nguồn và lịch sử git |
| Thư viện | Một phần: chỉ có `mux.js 7.0.3` đi kèm, không có công cụ audit. yt-dlp, FFmpeg, Node được tải từ GitHub/nodejs.org và kiểm SHA-256 (tệp checksum lấy cùng nguồn) |
| CI/CD, hạ tầng | Không có |
| Điểm vào (message, sự kiện trang, native host) | Đã kiểm |
| XSS trong trang tiện ích | Đã kiểm: chỉ `innerHTML` với biểu tượng SVG cố định; dữ liệu trang đi qua `textContent`/`setAttribute`; shadow DOM `closed` |
| Native host | Đã kiểm: URL chỉ YouTube qua `normalize()`, có `--` trước URL, `shell: false`, `--ignore-config`; mở thư mục chỉ khi file nằm trong thư mục tải và đang tồn tại; Explorer luôn dùng `/select` (chọn, không chạy) |
| Thử động | Bằng test hồi quy trong vm (đỏ trên `f70aa45`, xanh sau sửa). Chưa thử trên Chrome thật |

## Phát hiện

| ID | Mức | Tin cậy | Bằng chứng | Vị trí | Sửa |
| --- | --- | --- | --- | --- | --- |
| SEC-001 | Trung bình | Vừa | Đã tái hiện (test đỏ) | `content.js` extOf; `background.js` vc:startHls, vc:download; `manager.js` saveOutputs | `724a4d0` |
| SEC-002 | Thấp | Cao | Đã tái hiện | `background.js` onMessage (getMedia, diagnostics, manifestText, sources, clearMedia, probeSource, startHls, download, referer) | `193f596` |
| SEC-003 | Thấp | Cao | Đã tái hiện | `background.js` vc:inline | `5d1111f` |
| SEC-004 | Thấp | Cao | Đã tái hiện | `background.js` vc:saveRecording | `0d8ede9` |

### SEC-001: trang web đặt được đuôi file chạy được

**Kịch bản:** trang trả file `https://…/movie.exe` (hoặc `.hta`, `.bat`) với `Content-Type: video/mp4`. Tiện ích liệt kê nó là video vì header là video. Menu trên trang lấy đuôi từ link nên hiện "Video .exe". Người dùng bấm tải, Trình tải lưu `Tên phim.exe` vào Downloads hoặc thư mục tự chọn. Sau đó người dùng mở thư mục và bấm đúp, tưởng là video.

**Điều kiện:**

- người dùng bấm tải;
- người dùng mở file;
- Chrome có thể cảnh báo file nguy hiểm khi lưu qua Downloads; với thư mục tự chọn (File System Access) thì chưa kiểm.

Popup đã lọc đuôi media nhưng menu trên trang, background và Trình tải thì không.

**Sửa:** chỉ nhận đuôi media (`mp4`, `webm`, `mkv`, `mov`, `ts`, `m4a`, `mp3`…) ở cả ba lớp: menu, background và Trình tải ngay trước khi ghi file. Đuôi khác thành `.mp4`.

**Test:**

- `tests/frames.test.cjs` "SEC-001…"
- `tests/hls-sources.test.cjs` "SEC-001…"

### SEC-002: content script hỏi được dữ liệu của tab khác

**Kịch bản:** các lệnh nhận `msg.tabId` mà không xem ai gửi. Nếu renderer của một trang bị chiếm, content script trong đó có thể đọc danh sách video, playlist (link kèm token) đã bắt ở tab khác. Nó cũng có thể đặt Referer cho request của tiện ích hoặc gọi `chrome.downloads`.

**Sửa:**

- Chỉ trang của tiện ích (popup, Trình tải, Chẩn đoán) được chỉ định tab khác.
- Content script luôn dùng tab của chính nó.
- `vc:download`, `vc:referer`, `vc:probeSource` chỉ nhận từ trang tiện ích.

### SEC-003: trang giả sự kiện playlist làm phình bộ nhớ

**Kịch bản:** trang phát sự kiện `video-catcher:manifest` (`hook.js` dùng sự kiện DOM nên trang giả được) 60 lần, mỗi lần 4 MB. Service worker phải giữ khoảng 240 MB.

**Sửa:** mỗi tab giữ tối đa 16 MB, bỏ bản cũ nhất trước.

### SEC-004: lệnh lưu bản ghi nhận link và hậu tố tuỳ ý

**Kịch bản:** renderer bị chiếm gửi `vc:saveRecording` với link `https://…/x.exe` hoặc hậu tố `../../x.exe`, khiến tiện ích tải về và đặt tên tuỳ ý.

**Sửa:** chỉ nhận link `blob:` và hậu tố dạng `[chữ số_-].webm|mp4|mkv`.

## Phụ lục: giả thuyết chưa chứng minh

- **Request kèm cookie tới link trong playlist:** Trình tải gửi request kèm cookie, bỏ qua CORS, tới mọi link trong playlist mà trang cung cấp (kể cả địa chỉ mạng nội bộ). Dữ liệu chỉ ghi ra đĩa của người dùng, không gửi về trang, và cần người dùng bấm tải. Chưa thấy đường lộ dữ liệu; còn lại rủi ro GET có tác dụng phụ.
- **Tab thu YouTube:** token nằm trong `#vc-capture=` của URL nên chính trang YouTube đọc được và có thể gửi dữ liệu giả cho lượt thu. Tác động chỉ là video lưu ra sai; nguồn dữ liệu vốn là YouTube.
- **Lưu vào thư mục tự chọn:** cần kiểm trên Chrome thật xem File System Access có chặn đuôi nguy hiểm không. Sau SEC-001 điều này không còn ảnh hưởng tới tiện ích.
- **Commit trung gian:** commit `724a4d0` (SEC-001) dùng hàm `tabOf` của SEC-002 nên chạy riêng thì 2 test lỗi. Cả chuỗi `724a4d0..0d8ede9` qua 105/105 test.

Không có phát hiện mức Cao hoặc Nghiêm trọng trong phạm vi đã đánh giá. Điều này không có nghĩa là tiện ích an toàn tuyệt đối.
