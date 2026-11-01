# Kiểm tra bảo mật lần 2 – 01/11/2026

**Trạng thái: Một phần.**

- Đã đọc lại mọi điểm vào và tái hiện từng phát hiện bằng test trong vm.
- Đã chạy lại tiện ích trên Chromium thật sau khi sửa.
- Chưa thử trên Windows thật: luồng NTLM qua UNC, bộ tải YouTube trên máy.
- Chưa fuzz `lib/fmp4.js`, `lib/mpd.js`. Chưa đọc `lib/mux-mp4.min.js`.

Phạm vi: Video Catcher 1.7.0, từ `0a45e54` tới `9f4beed`. Báo cáo lần 1: `security-audit-2026-10-31.md`.

## Các bản sửa lần 1 còn đứng vững không

| Mục | Kết quả |
| --- | --- |
| SEC-001 (đuôi file chạy được) | Đứng vững. Cả ba đường lưu đều qua `safeExt`. Chromium thật: file `.exe` giả video được lưu thành `exe test.mp4`. |
| SEC-002 (content script đọc tab khác) | **Chưa kín.** Referer và hàng đợi tải vẫn nhận từ content script, xem SEC-009. |
| SEC-003 (giới hạn 16 MB/tab) | Đứng vững trong bộ nhớ. Nhưng 16 MB lớn hơn hạn mức 10 MiB của `storage.session`, xem SEC-007. |
| SEC-004 (lưu bản ghi) | Đứng vững. |

## Phát hiện mới (đã sửa ở `9f4beed`)

| ID | Mức | Tin cậy | Bằng chứng | Vị trí |
| --- | --- | --- | --- | --- |
| SEC-005 | Trung bình | Vừa | Tái hiện (vm); hành vi cookie/LAN của Chrome theo tài liệu | `background.js` getSources, manifestText, probeLength; `manager.js` fetchBytes, fetchManifest, probeOnce |
| SEC-006 | Thấp | Cao | Tái hiện (vm) | `background.js` setReferer |
| SEC-007 | Thấp | Vừa | Tái hiện (vm, hạn mức 10 MiB giả lập) | `background.js` persistInline, queueHls |
| SEC-008 | Thấp | Vừa | Tái hiện (đường dẫn kiểu win32); chưa thử NTLM thật | `youtube/locate.cjs` |
| SEC-009 | Thấp | Cao | Tái hiện (vm) | `background.js` vc:sources, vc:startHls |

### SEC-005: trang web khiến tiện ích gửi request kèm cookie tới máy trong mạng nội bộ

**Kịch bản:**

1. Trang có `<video><source type="application/x-mpegurl" src="http://192.168.1.1/cgi-bin/reboot.cgi">`. Một iframe quảng cáo cũng làm được.
2. Người dùng mở popup hoặc menu Tải.
3. Service worker gửi GET kèm cookie tới router.

Playlist giả qua sự kiện `video-catcher:manifest` (không cần mạng) cũng làm được việc này với đường dẫn `127.0.0.1`. Khi bấm Tải, Trình tải cũng gửi request tới mọi đoạn video trong playlist mà không kiểm máy chủ.

**Sửa:**

- Hàm `isPrivateHost` nhận diện localhost, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, `::1`, fc00::/7, fe80::/10, `.local`, `.lan`, `.internal` và tên một nhãn.
- Chỉ gửi request tới các máy đó khi chính trang đang xem cũng nằm trong mạng nội bộ (ví dụ Jellyfin trên NAS vẫn tải được).
- Kiểm ở mọi chỗ gửi request: đọc nguồn, đo dung lượng, kiểm nguồn trong Chẩn đoán, hàng đợi tải, và từng request của Trình tải.
- Trình tải chỉ tải link `http(s)`; `data:` và `chrome-extension:` bị từ chối.

**Test:**

- `tests/security.test.cjs` "SEC-005…" (2 test)
- `tests/manager.test.cjs` "SEC-005…"

**Còn lại (chấp nhận):**

- GET kèm cookie tới máy chủ **công khai** do trang khai báo. Đây là bản chất của trình tải video có quyền `<all_urls>`, cần người dùng mở menu, và kết quả không trả về cho trang.
- Tên miền công khai trỏ về IP nội bộ (DNS rebinding) chưa chặn được, vì tiện ích không biết IP đích.

### SEC-006: luật Referer dùng chung, không bao giờ xoá, trang làm cạn được

**Lỗi cũ:**

- Mỗi lần mở menu, tiện ích cài một luật Referer cho mỗi máy chủ mà trang khai báo.
- Mã luật là băm tên máy chủ. Hai máy chủ trùng mã thì xoá luật của nhau, ví dụ `cdn995.example` và `cdn23680.example`.
- Luật không bao giờ bị xoá. Mở menu khoảng 50 lần trên trang xấu là chạm giới hạn 5000 luật phiên. Sau đó mọi lượt tải cần Referer ở mọi tab đều lỗi tới khi khởi động lại trình duyệt.

**Sửa:**

- Mỗi máy chủ một ô cố định, tối đa 500 ô. Khi đầy thì bỏ ô dùng lâu nhất.
- Luật đọc từ menu không ghi đè và không đẩy ra luật mà Trình tải đặt cho lượt tải.
- Luật kiểu băm của bản cũ được dọn khi service worker khởi động.

**Test:** `tests/security.test.cjs` "SEC-006…" (2 test)

### SEC-007: playlist giả làm đầy storage.session, tab khác không tải được

**Lỗi cũ:**

- Hạn mức `storage.session` là 10 MiB, dùng chung cho mọi tab và mục tải.
- Giới hạn 16 MB/tab của SEC-003 lớn hơn hạn mức đó.
- Một tab nền giữ khoảng 9,6 MB, nên `vc:startHls` ở tab khác báo lỗi quota.

Ngay cả khi không có kẻ tấn công, một playlist dựng trong trang lớn hơn khoảng 4 MB cũng có thể gặp lỗi này.

**Sửa:**

- Chỉ ghi tối đa 1,5 MB/tab và 4 MB tổng mọi tab; phần còn lại giữ trong bộ nhớ.
- Khi hết hạn mức, vẫn xếp hàng tải nhưng bỏ bản sao playlist.

**Test:** `tests/security.test.cjs` "SEC-007…" (2 test)

### SEC-008: bộ tải trên máy theo gợi ý thư mục dạng `\\máy\chia-sẻ`

**Kịch bản:**

1. Gợi ý thư mục `vcFolderPaths` nằm trong `chrome.storage.local`, nơi content script ghi được.
2. Một renderer bị chiếm ghi vào đó `\\attacker.example\share\Videos`.
3. Khi người dùng bấm Mở thư mục, `locate()` gọi `statSync` tới máy chủ SMB đó. Windows có thể gửi thông tin đăng nhập NTLMv2.

**Sửa:** chỉ nhận gợi ý có dạng ổ đĩa cục bộ `X:\`.

**Test:** `tests/security.test.cjs` "SEC-008…"

### SEC-009: SEC-002 chưa kín – content script chọn Referer và mục tải

**Lỗi cũ:**

- `vc:referer` đã chỉ nhận từ trang tiện ích. Nhưng `vc:sources` vẫn nhận `msg.referer` và `declaredSources[].referer` từ content script rồi cài luật.
- `vc:startHls` nhận URL, `kind` (kể cả `youtube`) và Referer tuỳ ý. Trình tải sau đó gửi lại Referer này qua `vc:referer` với tư cách trang tiện ích, nên vượt qua được cổng kiểm của SEC-002.

**Sửa (với content script):**

- Referer là URL của chính khung gửi, hoặc Referer tiện ích đã ghi nhận cho tab.
- `kind` chỉ được là `hls`, `dash` hoặc `file`.
- URL phải là link đã liệt kê cho tab đó: mục đã bắt, `video.src`, mức chất lượng hoặc luồng tiếng. Danh sách này được giữ riêng, không phụ thuộc bộ đệm playlist 5 giây.

Trang tiện ích (popup) giữ nguyên hành vi.

**Test:** `tests/security.test.cjs` "SEC-009…" (3 test). Có một test bắt được lỗi hồi quy do chính bản sửa gây ra (bấm chất lượng sau khi bộ đệm hết hạn) trước khi commit.

### Gia cố đi kèm

- Tên file `CON`, `NUL`, `COM1`… được thêm `_` ở đầu.
- Ký tự đảo chiều chữ (U+202E…) bị bỏ khỏi tên file.

## Ứng viên chưa sửa (thiếu điểm vào hoặc tác động chưa đủ)

| Mục | Ghi chú / đề xuất |
| --- | --- |
| Lịch sử tải (IndexedDB) lưu link có token, tiêu đề, nhật ký của 200 mục | Manifest không khai báo `incognito`, nên mặc định là "spanning": tải trong ẩn danh vẫn ghi vào lịch sử. Đề xuất `"incognito": "split"` hoặc không lưu lịch sử của tab ẩn danh. |
| Nút "Sao chép báo cáo" ở Chẩn đoán chép đủ link media, link playlist và 1800 ký tự playlist có chữ ký | Trình tải đã lược link khi sao chép; Chẩn đoán thì chưa. Đề xuất lược giống Trình tải. |
| `vc:youtubeInfo` trả `downloadDir` cho content script | Lộ đường dẫn và tên người dùng Windows cho renderer bị chiếm. Đề xuất chỉ trả cho trang tiện ích. |
| `vcFolderPaths`, `destLabel` trong `storage.local` | Content script đọc được đường dẫn cục bộ. Đề xuất chuyển sang IndexedDB của Trình tải. |
| Token thu YouTube nằm trong `#vc-capture=` | Chính trang YouTube đọc được. Tác động chỉ là video lưu ra sai (như lần 1). |
| `setup-youtube.ps1` tải `releases/latest` | Checksum lấy cùng nguồn: phát hiện được file hỏng, không chống được nhà phát hành bị chiếm. Đề xuất ghim phiên bản và SHA-256. |
| `vc:openManager` / `vc:openDiagnostics` từ content script không giới hạn | Chỉ có thể dùng để giành focus hoặc mở nhiều tab, và cần renderer bị chiếm. |
| `fromExtension` so tiền tố `sender.url` | Hiện không khai thác được vì không có `web_accessible_resources`. Đề xuất thêm `sender.origin`. |
| `youtube/host.log` | Không có token, nhưng ghi mã video YouTube và đường dẫn cục bộ trong stack trace. |

## Đã kiểm, đạt

- Native host:
  - URL được chuẩn hoá về `watch?v=<11 ký tự>`, đặt sau `--`;
  - chiều cao là số nguyên từ 144 đến 4320;
  - mẫu tên file cố định, chạy với `--ignore-config`, `--no-plugin-dirs` và `shell:false`;
  - Explorer chỉ dùng `/select` và từ chối đường dẫn có `"` hoặc xuống dòng.
- Manifest: không có `externally_connectable`, `web_accessible_resources` hay `onMessageExternal`; dùng CSP mặc định của MV3.
- XSS: `innerHTML` chỉ dùng cho biểu tượng SVG cố định. Dữ liệu từ trang đi qua `textContent`/`setAttribute`. Menu nằm trong shadow DOM `closed`.

Không có phát hiện mức Cao hoặc Nghiêm trọng trong phạm vi đã đánh giá. Điều này không có nghĩa là tiện ích an toàn tuyệt đối.
