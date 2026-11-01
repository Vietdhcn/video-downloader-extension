# Video Catcher 1.8.0

[English](README.md) · **Tiếng Việt**

Tiện ích Chrome / Edge bắt và tải video trên trang web: YouTube, luồng HLS (`.m3u8`), DASH (`.mpd`) và file MP4/WebM/MP3. Giao diện English (mặc định) / Tiếng Việt — đổi trong ⚙ Cài đặt, kiểu Material 3, tự theo chế độ sáng/tối.

- Bấm **Tải** trên video, chọn chất lượng, video được đưa vào **Trình tải** (một cửa sổ nhỏ kiểu IDM).
- YouTube tải được ngay chỉ với Chrome (tới 1080p). Cài thêm bộ tải trên máy nếu cần 1440p/4K.
- HLS/DASH được tải song song và ghép thành MP4 ngay trong trình duyệt, không cần FFmpeg.
- Không tải được thì **ghi lại video đang phát**.

Các thay đổi theo phiên bản: [CHANGELOG.md](CHANGELOG.md). Kế hoạch sản phẩm: [PRODUCT_PLAN.md](PRODUCT_PLAN.md).

## Cài đặt

1. Mở `chrome://extensions` (hoặc `edge://extensions`).
2. Bật **Developer mode**, bấm **Load unpacked**, chọn thư mục dự án này.
3. Ghim Video Catcher lên thanh công cụ, tải lại các tab đang mở video.

**Cập nhật code mới:** đợi các lượt tải xong, đóng Trình tải, bấm **⟳ Tải lại** ở thẻ Video Catcher trong `chrome://extensions`, rồi tải lại trang. Thay đổi chỉ ở popup thì chỉ cần đóng và mở lại popup.

## Sử dụng

### Trên trang có video

- **YouTube:** có nút ⬇ trên thanh điều khiển của trình phát (dùng được cả ở chế độ rạp hát và toàn màn hình) và nút **⬇ Tải** trong hàng nút dưới video, cạnh Thích / Chia sẻ.
- **Trang khác:** rê chuột lên video, nút **Tải** hiện ở cạnh ngoài khung phát nên không che hình hay thanh điều khiển. Nếu video chiếm hết cửa sổ thì nút ẩn; khi đó dùng icon tiện ích.

Bấm nút sẽ mở menu: tên và ảnh video, danh sách chất lượng (mức · codec · dung lượng ước tính · ⬇) với mức **Đề xuất** (1080p hoặc mức cao nhất dưới 1080p). Bấm một hàng là thêm vào Trình tải. Chân menu có các chip:

| Chip | Tác dụng |
| --- | --- |
| 📁 Nơi lưu | Mở Trình tải để đổi thư mục lưu |
| Chẩn đoán | Xem tiện ích đã bắt được gì trên trang (không có trên YouTube) |
| Ẩn ở trang này | Ẩn nút tải trên trang web này; bật lại trong ⚙ Cài đặt của popup |

### Popup (icon tiện ích)

- **Thanh trên:** ⬇ mở Trình tải · ↻ quét lại trang · ⚙ Cài đặt.
- **Giữa:** mỗi nguồn bắt được là một thẻ (YouTube, HLS/DASH, file) có danh sách chất lượng; mức thấp được gập trong "N mức thấp hơn". Menu ⋯ của thẻ có sao chép link và lệnh ffmpeg.
- **Ghi lại video đang phát:** thu gọn bên dưới, tự mở khi trang không có gì tải được.
- **Chân:** công tắc **Nút tải ở trang này** và nút nơi lưu (hiện tên thư mục cuối; rê chuột để xem đường dẫn đầy đủ).
- **⚙ Cài đặt:** ngôn ngữ giao diện (English / Tiếng Việt), bật/tắt nút tải trên mọi trang, đổi nơi lưu, số video tải cùng lúc (1–5), danh sách trang đã ẩn nút kèm **Hiện lại**, trạng thái bộ tải YouTube trên máy.

### Trình tải

Thanh trên: **nơi lưu** (bấm để đổi thư mục; ⋯ bên cạnh có thư mục con trong Downloads và **Hỏi nơi lưu mỗi lần**) · **N cùng lúc** · ⏸ **Tạm dừng tất cả** / ▶ **Tiếp tục tất cả** · 🗑 **Dọn** các mục đã xong.

Các mục chia theo nhóm **Đang tải / Cần xử lý / Đã xong**:

| Nút | Tác dụng |
| --- | --- |
| ⏸ Tạm dừng | Dừng tải nhưng giữ phần đã tải; mục tạm dừng nhường chỗ cho video đang chờ |
| ▶ Tiếp tục | Tải tiếp từ chỗ đã dừng (YouTube qua bộ tải trên máy: yt-dlp tải tiếp file `.part`) |
| ✕ (đang tải / đang chờ / tạm dừng) | Huỷ lượt tải hoặc bỏ khỏi hàng chờ |
| Dừng & lưu | Với livestream HLS: dừng và lưu phần đã tải |
| Thử lại | Tải lại mục lỗi, đã huỷ hoặc bị gián đoạn |
| Mở thư mục | Mở File Explorer và chọn sẵn file vừa lưu (với thư mục tự chọn cần bộ tải trên máy, vì Chrome không cho biết đường dẫn thật) |
| ✕ (đã xong / lỗi) | Xoá mục khỏi danh sách; **không xoá file trên máy** |

- Bấm vào tên mục khi đang chờ hoặc đang tải để đổi tên file (không cần gõ đuôi `.mp4`). Lưu xong, tên mục là tên file thật trên đĩa, kể cả `(1)`, `(2)` khi trùng tên.
- Dữ liệu đang tải được ghi dần ra file tạm trên ổ đĩa, không giữ trong RAM; cần chỗ trống khoảng gấp đôi dung lượng video lúc lưu. File tạm tự xoá khi xong, huỷ hoặc xoá mục.
- Không tạm dừng được: livestream HLS (dùng **Dừng & lưu**) và YouTube đang thu trong trình duyệt. File từ máy chủ không hỗ trợ tải theo khoảng byte sẽ tải lại từ đầu khi tiếp tục.
- **Giữ cửa sổ Trình tải mở đến khi tải xong.** Đóng cửa sổ sẽ dừng lượt đang chạy; khi mở lại, mục đó hiện "bị gián đoạn" để **Thử lại**.
- Lịch sử tải (tối đa 200 mục) được giữ khi đóng/mở lại Trình tải.
- Tab **Lỗi** gom các video tải lỗi: mỗi mục có nguyên nhân, nhật ký từng bước (thử lại, đoạn chậm, lỗi cuối; không ghi link có token) và nút **Tải lại**, **Tải lại tất cả**, **Sao chép nhật ký** để gửi báo lỗi.
- Mục lỗi nói rõ nguyên nhân (link hết hạn, HTTP 429/5xx, mất mạng, DRM, ổ đầy, thiếu quyền ghi…) kèm nút phù hợp: Mở trang nguồn, Lưu lại, Lưu vào Downloads, Cấp quyền ghi, Tải trong trình duyệt, Sao chép chi tiết.

**Nơi lưu:** mặc định `Downloads/Video Catcher`. Có thể chọn một thư mục bất kỳ để ghi trực tiếp (File System Access API); sau khi mở lại trình duyệt có thể phải bấm **Cấp quyền ghi**. Bản ghi bằng "Ghi lại" luôn lưu vào Downloads.

## Tải YouTube

| | Chỉ có Chrome (mặc định) | Bộ tải trên máy (yt-dlp + FFmpeg) |
| --- | --- | --- |
| Cài đặt | Không cần | Chạy `setup-youtube.cmd` một lần |
| Chất lượng | Tới 1080p, H.264 + AAC | Mọi mức video có, tới 4K (1440p/4K thường là AV1) |
| Tốc độ | Theo tốc độ trình phát YouTube tải | Nhanh, tải trực tiếp |
| Nơi lưu | Nơi lưu của Trình tải | `downloads/` trong dự án hoặc thư mục đã chọn khi cài |

- Danh sách chất lượng được đọc sẵn từ trang ngay khi video tải xong, nên hiện ngay khi mở menu, kèm dung lượng ước tính.
- Chỉ liệt kê mức có bản MP4; mỗi mức ưu tiên H.264, không có thì dùng AV1. Không chuyển mã lại.
- Link có `list=...` chỉ tải **video đang xem**, không tải cả danh sách phát.
- **Chế độ chỉ có Chrome:** Trình tải mở video ở một tab mới đã tắt tiếng, thu dữ liệu trình phát tải về rồi ghép MP4. Tab này tự đóng khi xong; có thể chuyển sang tab khác nhưng **đừng đóng tab thu**. Video có quảng cáo sẽ chờ quảng cáo hết. Video cần đăng nhập vẫn tải được nếu bạn xem được.
- Khi bộ tải trên máy lỗi, mục lỗi có nút **Tải trong trình duyệt** để chuyển sang chế độ chỉ có Chrome.

### Cài bộ tải YouTube trên máy (không bắt buộc, Windows x64)

1. Cài tiện ích trước (để có ID tiện ích).
2. Chạy **`setup-youtube.cmd`** trong thư mục dự án.
3. Khi hiện `YouTube helper ready`, tải lại tiện ích và trang YouTube. Mục **Bộ tải YouTube trên máy** trong ⚙ Cài đặt của popup sẽ báo đang chạy.

Trình cài tải yt-dlp và FFmpeg từ kho chính thức của yt-dlp và kiểm tra SHA-256; dùng Node.js 22+ có sẵn hoặc tải Node.js LTS. Không cần Python. Bộ tải đăng ký Native Messaging `com.videocatcher.youtube` trong Registry **HKCU**, chỉ cho phép đúng ID tiện ích này; không mở cổng mạng, không đọc cookie hay tài khoản trình duyệt.

`setup-youtube.cmd` chạy PowerShell với `-ExecutionPolicy Bypass` chỉ cho lần cài đó, không đổi cài đặt bảo mật của máy. Luôn chạy qua file `.cmd`, không chạy trực tiếp `.ps1`. Tham số thêm:

```powershell
.\setup-youtube.cmd -ExtensionId "ID_TIEN_ICH_32_KY_TU"   # khi không tự tìm thấy ID
.\setup-youtube.cmd -DownloadDir "D:\Videos"               # đổi nơi lưu YouTube
```

Chạy lại trình cài khi chuyển thư mục dự án, đổi ID tiện ích hoặc muốn cập nhật yt-dlp. Có lỗi thì xem `youtube/host.log`.

Tải bằng dòng lệnh (sau khi cài):

```powershell
.\youtube\tools\node.exe .\youtube\download.cjs "https://www.youtube.com/watch?v=VIDEO_ID" 1080
```

## Tải kèm phụ đề & thuyết minh (CC and dịch)

Cài thêm tiện ích **Song Ngữ & Thuyết Minh** (dự án "CC and dịch") và bật nó trên video. Menu tải sẽ có mục
**Phụ đề & thuyết minh (CC and dịch)**: chọn cách đưa phụ đề vào file (in cứng đúng kiểu chữ đang xem / track bật-tắt / cả hai)
(ô **Phụ đề**: Gốc · Dịch · Cả hai; ô **Ghi phụ đề**: Không · In cứng · Track · Cả hai) và thuyết minh (**Tiếng gốc**: thêm bản thuyết minh riêng · **Tiếng dịch**: chỉ giọng thuyết minh · **Trộn**: giọng + tiếng gốc hạ). Lựa chọn được nhớ cho lần sau.
Bật/tắt mục này trong **Cài đặt** của popup (*Kèm phụ đề & thuyết minh*, mặc định bật); *Giữ file phụ đề & thuyết minh rời* (mặc định tắt) giữ `Tên video.vi.srt/.vi.ass/.thuyet-minh.wav` cạnh video sau khi ghép. File tạm đi thẳng tới bộ tải trên máy (`%TEMP%\VideoCatcher`), không qua Chrome Downloads nên không bị hỏi nơi lưu. Cần bộ tải trên máy (ffmpeg) — xem mục **Tải YouTube**. Video tải xong sẽ hiện "Đang ghép phụ đề + thuyết minh… 42%" trong Trình tải;
file kết quả thay cho file thường, cùng tên. Thuyết minh cả video được tổng hợp ngay trong trình duyệt (giọng trên máy nhanh gấp
3–10 lần thời gian thực); giọng online tốn hạn mức theo độ dài video, menu có lựa chọn chuyển sang giọng trên máy.

## HLS, DASH và file thường

- **HLS / DASH → MP4:** tải tối đa 16 đoạn song song, ghép hình và tiếng trong trình duyệt. Đoạn nào chậm gấp 3 lần thường lệ (máy chủ đứng) được mở thêm một request song song, lấy bản về trước, để các luồng khác không phải đứng chờ; khúc cuối của file lớn cũng vậy. Hỗ trợ HLS AES-128, đoạn giả dạng ảnh/PDF, playlist có tiền tố giả, playlist tạo trong trang, fMP4 tách hình/tiếng. MPEG-TS được chuyển sang MP4 bằng mux.js; không chuyển được thì lưu TS gốc. DASH WebM lưu hình/tiếng thành hai file kèm lệnh ghép ffmpeg.
- **File MP4/WebM/MP3:** tải nhiều luồng (tối đa 8) nếu máy chủ hỗ trợ Range, nếu không thì tải một luồng; đứt kết nối giữa chừng thì tải tiếp từ chỗ đã nhận, không tải lại từ đầu. Máy chủ trả trang lỗi thay vì video (link hết hạn) thì báo lỗi rõ, không lưu file rác.
- **Livestream HLS:** tải liên tục đến khi bấm **Dừng & lưu**.
- **Ghi lại:** ghi video đang phát bằng captureStream + MediaRecorder, mất thời gian bằng thời lượng video.

## Khi không thấy nguồn tải

1. Chờ quảng cáo hết, cho video chính phát vài giây rồi mở lại menu (hoặc bấm ↻ trong popup).
2. Chọn nguồn có thời lượng khớp video chính; file nhỏ thường là quảng cáo.
3. Với nguồn mã hoá do trình phát xử lý, chỉ mức đã phát mới tải được: chọn mức đó trên trình phát, phát vài giây rồi mở lại menu.
4. Vẫn thiếu: mở **Chẩn đoán** từ chip ở chân menu. Trang này tóm tắt ✓ ổn / ! cần làm / ✕ không tải được kèm việc nên làm; **Sao chép báo cáo** khi cần báo lỗi (báo cáo không tự gửi đi đâu).

Bấm tải xong là có thể đóng tab video: mục tải mang theo bản sao các playlist mà trang tự dựng, nên vẫn tải được (kể cả khi còn chờ trong hàng hoặc bấm Thử lại). Riêng **Ghi lại** dừng khi đóng tab, và đừng đóng tab thu của YouTube trong trình duyệt. Sau khi đóng rồi mở lại Trình tải, mục cũ chỉ Thử lại được nếu playlist tải được qua mạng; không thì mở lại trang và phát video.

**Lỗi trên trang `chrome://extensions` trỏ vào `hook.js`:** để bắt link video, tiện ích bọc hàm `fetch` của trang. Khi chính trang gọi một yêu cầu bị chính sách bảo mật (CSP) của nó chặn, ví dụ màn kiểm tra của Cloudflare gọi `fetch('data:;')`, Chrome ghi lỗi vào tiện ích vì `hook.js` nằm trong ngăn xếp. Lỗi này vô hại, trang vẫn chạy bình thường, và chỉ hiện khi tiện ích được nạp ở Developer mode.

## Giới hạn

- Không vượt DRM (Widevine, PlayReady, FairPlay), HLS SAMPLE-AES hay DASH ContentProtection.
- YouTube: chưa tải livestream. Nếu YouTube đòi xác minh hoặc đổi cơ chế phát, lỗi hiện trong Trình tải; không đảm bảo mọi video luôn tải được.
- Chưa hỗ trợ livestream DASH; dùng Ghi lại nếu trang cho phép.
- Một số trang chặn captureStream/CORS nên không ghi được.
- MP4 ghép trong trình duyệt là MP4 phân mảnh. Trình phát cũ không mở được thì chuẩn hoá bằng `ffmpeg -i input.mp4 -c copy output.mp4`.
- Không gắn nút tải lên video camera hay cuộc gọi.

## Cấu trúc mã

```text
manifest.json              Phiên bản, quyền, content scripts (MV3)
background.js              Bắt nguồn qua webRequest, đọc playlist, thông tin YouTube, mở Trình tải
hook.js                    (MAIN world) Bắt manifest qua Fetch/XHR/Blob/hls.js
content.js                 Nút Tải, menu chất lượng, nút YouTube, ghi hình
popup.html/.css/.js        Popup và Cài đặt
manager.html/.css/.js      Trình tải: hàng chờ, tải song song, ghép, lưu, lịch sử
diagnostics.html/.js       Trang Chẩn đoán
lib/youtube.js             Đọc chất lượng/dung lượng YouTube từ trang
lib/yt-capture.js          Thu YouTube trong tab thu (chỉ khi URL có #vc-capture)
lib/native-youtube.js      Kết nối bộ tải YouTube trên máy
lib/m3u8.js, mpd.js        Phân tích HLS / DASH
lib/fmp4.js                Ghép fMP4
lib/mux-mp4.min.js         mux.js 7.0.3 (Apache-2.0), chuyển MPEG-TS sang MP4
lib/errors.js              Phân loại lỗi cho thẻ tải
lib/i18n.js, lib/locales/  Ngôn ngữ giao diện: VCI18n.t(khoá, [tham số]), từ điển en.js / vi.js, data-i18n cho HTML tĩnh
tools/i18n-tool.cjs        Tách chuỗi tiếng Việt ra tools/i18n/*.json, thay bằng VCI18n.t(), sinh lib/locales
lib/position.js, frames.js Vị trí nút/menu, nhận diện iframe trình phát
setup-youtube.cmd          Trình cài bộ tải YouTube (Windows)
youtube/native-host.cjs    Bộ tải trên máy: hello / inspect / download / openFolder / reveal / stage* / postprocess
youtube/postprocess.cjs    Ghép phụ đề & thuyết minh bằng ffmpeg; nhận file tạm theo khúc base64
youtube/locate.cjs         Tìm file vừa lưu trong thư mục tự chọn để Mở thư mục
youtube/download.cjs       Tải YouTube bằng dòng lệnh
```

Bỏ qua trong Git: `youtube/tools/`, `youtube/config.json`, `youtube/host.log`, `downloads/`.

## Phát triển

Cần Node.js 22+, không cần cài gói npm. Kiểm tra thực tế YouTube bằng `youtube/download.cjs`, rồi xem file bằng `youtube/tools/ffprobe.exe`.

## Nguồn công cụ

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) và [FFmpeg builds của yt-dlp](https://github.com/yt-dlp/FFmpeg-Builds)
- [Node.js](https://nodejs.org/)
- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)

Chỉ tải hoặc ghi nội dung bạn sở hữu hoặc được phép lưu.
