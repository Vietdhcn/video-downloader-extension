# Nhật ký thay đổi – Video Catcher

Ghi lại các thay đổi theo phiên bản, mới nhất ở trên. Hướng dẫn sử dụng: [README.vi.md](README.vi.md) (tiếng Việt) · [README.md](README.md) (English).

## 1.8.0

- **Giao diện song ngữ English / Tiếng Việt, mặc định English.** Đổi trong ⚙ Cài đặt của popup (mục *Language / Ngôn ngữ*), áp dụng
  ngay cho popup, menu tải trên trang, Trình tải (không tải lại trang, không dừng lượt tải), trang Chẩn đoán và thông báo của bộ tải trên máy.
  Tên và mô tả tiện ích trong chrome://extensions chuyển sang tiếng Anh. Kỹ thuật: `lib/i18n.js` (`VCI18n.t(khoá, [tham số])`, đọc
  `chrome.storage.local.lang`) + từ điển `lib/locales/{en,vi}.js`; HTML tĩnh dùng `data-i18n`; bộ tải trên máy nhận `lang` trong
  từng thông điệp. Chuỗi được tách và thay tự động bằng `tools/i18n-tool.cjs` (`extract` → dịch `tools/i18n/en.json` → `apply`;
  `tools/i18n/vi.json` là nguồn tiếng Việt gốc của mọi khoá). Phân loại lỗi (`lib/errors.js`) so khớp cả thông báo tiếng Anh lẫn tiếng Việt.

- **Tải kèm phụ đề song ngữ & thuyết minh từ tiện ích "Song Ngữ & Thuyết Minh" (CC and dịch).** Khi tiện ích đó đang chạy trên video,
  menu tải có thêm mục **Phụ đề & thuyết minh (CC and dịch)** với các lựa chọn, nhớ cho lần sau:
  - *Phụ đề*: Gốc · Dịch · Cả hai (theo cài đặt hiển thị của CC and dịch, kèm phiên âm nếu đang bật).
  - *Ghi phụ đề*: Không · **In cứng vào hình** (đúng dòng phiên âm/gốc/dịch, cỡ chữ, màu, nền, phông, vị trí như đang xem;
    mã hoá lại hình bằng NVENC nếu có, không thì libx264) · **Track phụ đề bật/tắt** (mov_text trong MP4, SRT trong MKV) · Cả hai.
  - *Thuyết minh trong file*: **Không** · **Tiếng gốc** (giữ tiếng gốc làm mặc định, thuyết minh là bản âm thanh thứ 2 chọn khi xem) ·
    **Tiếng dịch** (chỉ giọng thuyết minh, bỏ tiếng gốc) · **Trộn** (giọng đọc + tiếng gốc hạ đúng mức đã cài, ramp mượt).
  - *Giọng online* (Gemini/Azure/ElevenLabs…): dùng đúng giọng (hiện ước tính số phút tốn hạn mức) hoặc chuyển sang giọng trên máy.
  - Bật/tắt toàn bộ mục này trong **Cài đặt** của popup (*Kèm phụ đề & thuyết minh*, mặc định bật); *Giữ file phụ đề & thuyết minh rời*
    (mặc định tắt): bật thì sau khi ghép giữ `Tên video.vi.srt`, `.vi.ass`, `.thuyet-minh.wav` cạnh video, tắt thì xoá ngay.
  - Áp dụng cho mọi nguồn: YouTube (bộ tải trên máy), HLS/DASH/file (Trình tải). Cần bộ tải trên máy (ffmpeg trong `youtube/tools`).
- Cách hoạt động: mục tải được tạo ngay; CC and dịch tạo phụ đề ASS/SRT và file WAV thuyết minh ngay trong trang (dịch nốt phần chưa dịch,
  tổng hợp từng câu với tốc độ tự co giãn như khi xem, không chồng câu), chuyển thẳng cho bộ tải trên máy theo khúc base64 qua
  service worker (lệnh `stageBegin/stageChunk/stageEnd`, file tạm trong `%TEMP%\VideoCatcher\<mã mục>` — không qua Chrome Downloads nên không
  bị hộp thoại "Hỏi nơi lưu", không rác trong Downloads); tải xong video thì ghép bằng ffmpeg (lệnh `postprocess`), thay file gốc, xoá file tạm.
  Lỗi ở bước ghép không làm mất video đã tải; nút **Bỏ qua** dừng ghép và giữ video thường.
- Bộ tải trên máy: `youtube/postprocess.cjs` (kiểm tra đường dẫn cục bộ/đuôi cho phép, dựng lệnh ffmpeg, tiến độ, thay file an toàn).

## 1.7.0

- **Udemy: mỗi bài một tên file.** Tên file (và tiêu đề menu) lấy theo bài đang xem: `Tên khoá - 12. Tên bài.mp4`, thay vì mọi bài cùng tên khoá học. Cách lấy tên bài, theo thứ tự:
  1. Từ danh sách bài.
  2. Hỏi Udemy theo mã bài, khi danh sách bài đang đóng.
  3. `Tên khoá - bài <mã bài>`, để không bao giờ trùng tên.

  Áp dụng cho menu trên trang, popup và bản ghi.
- **Tự động lưu** (Cài đặt của popup, và mục ⋯ cạnh nơi lưu trong Trình tải), mặc định bật. Bỏ tích thì mỗi video tải xong hiện hộp thoại "Lưu thành" của Chrome để tự chọn thư mục và tên file, kể cả khi đã chọn thư mục riêng; thanh trên Trình tải hiện nhãn "Hỏi khi lưu". Đóng hộp thoại thì mục báo rõ và còn nút **Lưu lại**. Ô này thay cho ô "Hỏi nơi lưu mỗi lần" cũ (ngược chiều, chỉ dùng được với Downloads).
- **Lỗi → tab Lỗi:** mục tải vừa lỗi tự mở tab **Lỗi** tại thẻ của nó. Bấm **Tải lại** thì quay về tab Tất cả để xem tiến độ.
- **Tải lại vẫn lỗi:** thẻ lỗi có link **Mở trang video gốc** để bắt đầu lại từ đầu với link phát mới. Nếu tab cũ vẫn ở trang đó thì tab được nạp lại, nếu không thì mở tab mới. Số lần tải lại được giữ khi mở lại Trình tải.
- **Báo video trùng:** khi thêm một video đang tải ở mục khác, hoặc đã có trong ổ (theo lịch sử tải hay tên file trong Downloads / thư mục đã chọn), mục mới không tự tải mà báo rõ và cho chọn:
  - **Xem mục đang tải / đã tải**
  - **Mở thư mục**
  - **Vẫn tải**
  - **Bỏ**
- Kiểm tra lại 01/11 (xem `docs/engineering/security-audit-2026-11-01.md`, `fixlog-2026-11-01.md`). **Bảo mật:**
  - Trang công khai không khiến tiện ích gửi request kèm cookie tới router, NAS hay localhost (SEC-005).
  - Luật Referer có giới hạn 500 máy chủ và không bị trang ghi đè (SEC-006).
  - Playlist trang tự dựng không làm đầy bộ nhớ phiên, nên tab khác vẫn tải được (SEC-007).
  - Bộ tải trên máy không mở đường dẫn mạng `\\máy\chia-sẻ` (SEC-008).
  - Menu trên trang chỉ tải được link tiện ích đã bắt, với Referer của chính trang (SEC-009).
  - Tên file `CON`/`NUL`… và ký tự đảo chiều chữ được xử lý.

  **Giao diện:** Chẩn đoán gọn một dòng ở cửa sổ hẹp; các trang có tiêu đề h1 cho trình đọc màn hình.
- Kiểm tra toàn diện 31/10 (xem `docs/engineering/fixlog-2026-10-31.md`): tạm dừng giữ phần khúc đang tải dở và tải tiếp đúng byte; không còn tải gấp đôi file nhỏ trên mạng chậm; nút chữ trên thẻ lỗi đủ tương phản; nhật ký ghi "Tiếp tục tải"; Chẩn đoán đếm theo luồng; hàng file ghi "MP4"; thanh trên Trình tải gọn ở cửa sổ hẹp, danh sách tối đa 960 px ở cửa sổ rộng.
- **Bảo mật** (xem `docs/engineering/security-audit-2026-10-31.md`): file tải về chỉ mang đuôi media, trang web không còn đặt được đuôi `.exe/.hta/.bat…` (SEC-001); content script chỉ đọc dữ liệu của chính tab nó, lệnh tải/Referer chỉ nhận từ trang của tiện ích (SEC-002); playlist trang tự dựng giới hạn 16 MB mỗi tab (SEC-003); lưu bản ghi chỉ nhận `blob:` và tên ngày giờ (SEC-004).
- Trình tải có tab **Lỗi** (kèm số mục): mỗi video lỗi một thẻ gồm **nguyên nhân** + việc nên làm, **nhật ký** (bắt đầu, playlist/manifest, dung lượng, các lần thử lại theo tên máy chủ, đoạn chậm, tạm dừng, lỗi cuối) và nút **Tải lại** / Lưu lại / Mở trang nguồn / Sao chép nhật ký; **Tải lại tất cả** khi có nhiều mục. Ô lỗi trong danh sách có **Xem nhật ký**. Nhật ký không ghi link (thường có token), được giữ trong lịch sử (60 dòng cuối).
- Video có DRM (vd khoá học trả phí): menu chỉ hiện một dòng "Video có DRM (bảo vệ bản quyền): trình duyệt không cho tải hay ghi lại.", không còn liệt kê các mức "không tải được", không gợi ý Ghi và không hiện nút Ghi (trình duyệt chặn ghi video DRM). Lỗi ghi do EME báo cùng câu đó thay vì thông báo dài. Chip nơi lưu trong menu chỉ ghi tên thư mục cuối.
- Tốc độ tải ổn định hơn: đoạn đầu hàng (HLS/DASH) hoặc khúc cuối của file tải chậm bất thường được mở thêm một request song song, lấy bản về trước, nên không còn cảnh mọi luồng đứng chờ một đoạn kẹt (tốc độ tụt về 0 rồi vọt lên). Tốc độ hiển thị lấy trung bình 5 giây và làm mượt; thời gian còn lại của YouTube tính theo tốc độ đã làm mượt.
- File tải một luồng bị đứt giữa chừng (hoặc tạm dừng) tải tiếp phần còn lại bằng `Range: bytes=n-` thay vì xoá tiến độ và tải lại từ 0. Khi đã tải được nhiều khúc mà máy chủ thôi trả từng đoạn, hoặc trả trang HTML/dữ liệu quá ít so với dung lượng, Trình tải báo "link có thể đã hết hạn" kèm Mở trang nguồn, không còn tụt từ hàng chục MB về vài KB rồi lỗi hay lưu file rác. Đo dung lượng lỗi thì đo lại một lần trước khi chuyển sang tải một luồng.
- Đóng tab video sau khi bấm tải không còn làm lỗi mục tải: playlist do trang tự dựng (vd RoPhim) được sao kèm mục tải, dùng được khi mục còn chờ trong hàng hoặc khi bấm Thử lại.
- **Tạm dừng / Tiếp tục** từng mục trong Trình tải và nút **Tạm dừng tất cả / Tiếp tục tất cả** trên thanh trên. HLS/DASH/file giữ phần đã tải; YouTube qua bộ tải trên máy tải tiếp file `.part`. Mục tạm dừng nhường chỗ cho video đang chờ.
- Thông báo của Trình tải (vd khi Mở thư mục tự chọn mà chưa cài bộ tải) hiện ở ô nổi dưới cùng, tự ẩn; trước đây bị chèn vào thanh trên và vỡ chữ khi cửa sổ hẹp.
- Sửa chữ chồng nhau: hàng **Đề xuất** trong popup (nhãn thay chỗ codec, codec vào tooltip), chân popup ("Nút tải ở trang này", nút nơi lưu chỉ ghi thư mục cuối), tiêu đề Trình tải một dòng.
- **YouTube tải được chỉ với Chrome**, không cần cài thêm: tiện ích mở video ở một tab tắt tiếng, thu dữ liệu H.264/AAC mà trình phát YouTube tải về và ghép MP4 trong Trình tải (tối đa 1080p). Máy đã cài bộ tải YouTube thì vẫn dùng bộ tải (tới 4K, nhanh hơn).
- Danh sách chất lượng YouTube **hiện ngay khi mở menu, đủ mọi mức video có** (tới 4K), kèm **dung lượng ước tính** và codec (ví dụ AV1 cho 4K). Tiện ích đọc trước danh sách từ trang ngay khi video tải xong và mỗi lần chuyển video, không phải chờ yt-dlp.
- Dung lượng ước tính khi có bộ tải trên máy tính theo đúng file sẽ tải (trước đây có lúc báo nhầm, ví dụ 32 GB cho 4K).
- Dữ liệu tải về được **ghi dần xuống file tạm trên ổ đĩa** thay vì giữ trong RAM; tải video dài không còn làm đầy bộ nhớ.
- **Thẻ lỗi có chẩn đoán**: nêu nguyên nhân (link hết hạn, HTTP 429/5xx, mạng, DRM, ổ đĩa đầy, quyền lưu…) kèm nút phù hợp như Mở trang nguồn, Lưu lại, Lưu vào Downloads, Tải trong trình duyệt, Sao chép chi tiết.
- **Lịch sử tải** được giữ khi đóng/mở Trình tải; mục đang dở hiện "bị gián đoạn" để Thử lại.
- Sửa nút **Tải video này** trên trang có trình phát cao 100% màn hình (VieON): menu luôn hiện trong màn hình ngay khi bấm.
- `setup-youtube.cmd` không còn bị lỗi *running scripts is disabled on this system*.
- Bấm tải chỉ hiện **một cửa sổ Trình tải nhỏ** (như hộp thoại tải của IDM); nhiều lượt tải dùng chung cửa sổ đó. Có thể mở lại bằng nút ⬇ (Trình tải) trên đầu popup.
- **Popup mới:** phần **Tải xuống** lên đầu, mỗi nguồn (YouTube, HLS/DASH, file) là một thẻ có tiêu đề video và danh sách chất lượng dạng hàng (mức · codec/bitrate · dung lượng · ⬇), bấm một hàng là thêm vào Trình tải. Sao chép link / lệnh ffmpeg nằm trong menu ⋯. **Ghi lại video đang phát** thu gọn bên dưới (tự mở khi không có gì để tải hoặc đang ghi). Chân popup: công tắc **Nút tải trên <trang đang xem>** và nơi lưu (bấm để đổi trong Trình tải). Popup chỉ vẽ khi đã có dữ liệu và chỉ cuộn phần giữa, nên không còn nhảy/đổi bề rộng. Hỗ trợ giao diện sáng/tối.
- Sửa dung lượng sai kiểu "0 kbps · ~117 B": trang ghi BANDWIDTH giả (vd: 1) nên không dùng để ước tính; khi đó đo đoạn đầu × thời lượng, ước tính phi lý (< 1 MB cho video > 1 phút) bị bỏ. Chữ trong popup và menu rút gọn tối đa.
- **Thiết kế Material 3** (ngôn ngữ thiết kế của Chrome) cho popup, menu tải, Trình tải và Chẩn đoán, chỉ dùng 2 nhóm màu: trung tính (trắng/đen/xám) và màu giao diện đỏ. Popup: ảnh thu nhỏ + bảng chất lượng có mức **Đề xuất** (1080p), mức thấp gập lại, thông báo kèm nút **Xem**, trang **Cài đặt** (nút tải mọi trang, nơi lưu, số video tải cùng lúc, trang đã ẩn nút, trạng thái bộ tải YouTube). Trình tải chia nhóm **Đang tải / Cần xử lý / Đã xong**; mục xong có dấu ✓, **Mở thư mục** và ✕ bên phải.
- **Giao diện mới cho mọi trang** (cùng bộ màu sáng/tối với popup): Trình tải có thanh trên dính (logo · nơi lưu · số video/lần · Dọn), mỗi mục có ảnh thu nhỏ YouTube hoặc nhãn HLS/DASH/MP4, thanh tiến trình chuyển màu, nút bo tròn, lỗi gọn một ô; trang Chẩn đoán có thanh trên, thẻ trang, đếm ✓ ổn / ! cần làm / ✕ lỗi và danh sách kiểm tra; thanh ghi hình trên trang dạng viên thuốc mờ. Gợi ý lỗi rút còn một câu.
- **⚙ Cài đặt** trong popup: bật/tắt nút tải cho mọi trang, đổi nơi lưu, và danh sách **các trang đang ẩn nút** với nút **Hiện lại** từng trang.
- **YouTube:** nút ⬇ trên **thanh điều khiển của trình phát** (cạnh phụ đề / cài đặt) nên có ở mọi chế độ: mặc định, rạp hát, toàn màn hình; menu mở ra phía trên nút với nền tối mờ giống menu của YouTube, có ảnh thu nhỏ video. Thêm nút **⬇ Tải** nằm luôn trong hàng nút dưới video (cạnh Thích / Chia sẻ, cùng kiểu nút YouTube, theo giao diện sáng/tối của YouTube); bấm là mở danh sách chất lượng ngay dưới nút, không phải rê chuột lên video. Trên trang xem YouTube không hiện thêm nút nổi cạnh trình phát.
- **Menu tải trên trang** làm lại: tiêu đề video, hàng chất lượng (mức · codec/fps · dung lượng · ⬇), các thao tác phụ (nơi lưu, Chẩn đoán, Ẩn trên trang này) thành chip ở chân menu; YouTube hiện danh sách một lần, không nhảy.
- **Mở thư mục** mở File Explorer và chọn sẵn file vừa tải, cả với YouTube (trước đây cửa sổ bị mở ẩn) và với **thư mục tự chọn** (trước đây chỉ hiện hộp chọn thư mục, không thấy file).
- **Trình tải gọn hơn:** một thanh trên cùng (📁 nơi lưu · số video/lần · Dọn); mỗi mục chỉ hiện tên file một lần (bấm vào tên để đổi trước khi lưu), xong thì một dòng "✔ Đã lưu · thời lượng · dung lượng" và nút **Mở thư mục**. Bỏ nhãn "Gốc", ô "Tên file (tự thêm đuôi)", các dòng hướng dẫn cố định; "Giữ cửa sổ này mở" chỉ hiện khi còn video đang tải.
- Trang **Chẩn đoán** dễ đọc: tóm tắt ✓ ổn / ! cần làm thêm / ✕ không tải được kèm việc nên làm; dữ liệu kỹ thuật nằm trong **Chi tiết kỹ thuật**.
- Menu nói rõ lý do khi bộ tải YouTube trên máy chưa dùng được; bộ tải ghi nhật ký vào `youtube/host.log` để dò lỗi.


## 1.6.7

- hỗ trợ 1–5 video cùng lúc trong Trình tải, mặc định 5 cho cấu hình mới; giữ lựa chọn đã lưu của người dùng. Video thêm trước được bắt đầu trước. Các lượt HLS/DASH/file trong trình duyệt dùng chung tối đa 16 request tải dữ liệu, tránh nhân số kết nối theo số video.
- Menu hiện đủ file đã bắt, thêm các nguồn `<source>` chưa phát và danh sách chất lượng do hls.js công bố. Nhãn phân biệt **720p HD**, **1080p Full HD**, QHD/4K, FPS và các lựa chọn codec/bitrate DASH. Các mức trang chưa công bố hoặc cần trình phát xử lý vẫn phụ thuộc vào trang.
- Kiểm tra Range trước khi chia file, phát hiện khoảng byte sai/thiếu, chuyển về tải một luồng nếu máy chủ ngừng hỗ trợ Range. Hủy request của cùng lượt khi một đoạn lỗi; dùng đúng URL sau chuyển hướng để tìm đoạn tương đối. Đọc tối đa 4 playlist nguồn song song thay vì lần lượt.

## 1.6.6

- HLS tải tối đa 16 đoạn đồng thời, file lớn tối đa 8 luồng. Thử lại kết nối không có phản hồi sau 30 giây hoặc không nhận thêm dữ liệu trong 15 giây; hủy ngay cả khi đang chờ thử lại. Không cộng trùng byte của lượt lỗi vào tiến trình. Chưa xác nhận tốc độ ngang IDM trên trình duyệt.

## 1.6.5

- mỗi mục HLS/DASH/file có ô **Tên file** để phân biệt tập/video trước khi lưu. Trình tải hiện tên thật do Chrome lưu, kể cả hậu tố `(1)`, `(2)` hoặc tên đổi trong Save As. Thư mục tự chọn tiếp tục tìm tên trống sau 999 mục trùng và bỏ qua thư mục cùng tên.

## 1.6.4

- hiện nút cả khi thẻ video chưa gán nguồn; nhận thêm sự kiện con trỏ qua lớp điều khiển của trình phát. Khi chưa có nguồn, menu hướng dẫn bấm phát video. Thay đổi này đã có kiểm thử cục bộ; chưa xác minh trực tiếp trên VieON.

## 1.6.3

- không đọc nhầm `#ENC-AESGCM` / `#EXT-X-B65` thành URL phân đoạn hoặc LIVE. Quan sát playlist sau lời gọi giải mã thành công của chính trình phát, không xuất khóa; ưu tiên bản playlist đã xử lý và giữ Referer của iframe khi đưa vào Trình tải.
- Với nguồn bọc mã hóa, chỉ bật chất lượng mà trình phát đã xử lý. Nếu dòng chất lượng yêu cầu chọn trên trình phát trước, chọn mức đó trong trình phát, cho phát vài giây rồi mở lại menu. Playlist phụ đề/tiếng riêng được gom dưới playlist tổng.

## Trước 1.6.3

- **YouTube → MP4:** chọn chất lượng ngay trong menu hoặc popup; tiến trình nằm chung trong Trình tải HLS/DASH, không mở tab YouTube riêng. Ghép hình/tiếng bằng yt-dlp + FFmpeg chạy trên máy.
- Nút **Tải video này** nằm **ngoài khung trình phát**, không che hình ảnh hoặc thanh điều khiển.
- Từng mục tải có **Mở thư mục** và **Xóa**; vẫn có **Hủy**, **Thử lại**, **Dọn danh sách**.
- Bắt thêm playlist từ Fetch dạng stream/ArrayBuffer, XHR nhị phân và Blob bị gán nhầm loại video/ảnh.
