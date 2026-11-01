# Video Catcher 1.8.0

**English** · [Tiếng Việt](README.vi.md)

A Chrome / Edge extension that catches and downloads videos from web pages: YouTube, HLS streams (`.m3u8`), DASH (`.mpd`) and plain MP4/WebM/MP3 files. English UI by default (switch to Vietnamese in Settings), Material 3 look, follows the system light/dark theme.

- Click **Tải** (Download) on a video, pick a quality, and the video goes to the **Download Manager** (a small IDM-style window).
- YouTube downloads work with Chrome alone (up to 1080p). Install the optional local helper for 1440p/4K.
- HLS/DASH segments are downloaded in parallel and muxed into MP4 right in the browser — no FFmpeg required.
- If nothing can be downloaded, **record the playing video** instead.
- With the companion extension **Song Ngữ & Thuyết Minh** (bilingual subtitles + voice dubbing), the downloaded file can carry **the subtitles and dubbing exactly as you watch them** — burned-in or as switchable tracks.

Version history: [CHANGELOG.md](CHANGELOG.md). Product plan: [PRODUCT_PLAN.md](PRODUCT_PLAN.md).

## Install

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**, click **Load unpacked**, select this project folder.
3. Pin Video Catcher to the toolbar and reload any tabs that are playing video.

**Updating the code:** wait for running downloads to finish, close the Download Manager, click **⟳ Reload** on the Video Catcher card in `chrome://extensions`, then reload the page. Popup-only changes just need the popup closed and reopened.

## Usage

### On a page with video

- **YouTube:** a ⬇ button on the player's control bar (also in theater and full-screen mode) and a **⬇ Tải** button in the row under the video, next to Like / Share.
- **Other sites:** hover the video and a **Tải** button appears at the outer edge of the player so it never covers the picture or the controls. If the video fills the whole window the button hides; use the extension icon instead.

The button opens a menu: title and thumbnail, the quality list (level · codec · estimated size · ⬇) with a **Recommended** level (1080p, or the highest level below 1080p). Clicking a row adds the video to the Download Manager. Chips at the bottom:

| Chip | Action |
| --- | --- |
| 📁 Save location | Opens the Download Manager to change the folder |
| Diagnostics | Shows what the extension caught on this page (not on YouTube) |
| Hide on this site | Hides the download button on this site; re-enable in the popup's ⚙ Settings |

### Popup (extension icon)

- **Top bar:** ⬇ open the Download Manager · ↻ rescan the page · ⚙ Settings.
- **Middle:** one card per detected source (YouTube, HLS/DASH, file) with its quality list; low levels are folded into "N lower levels". The card's ⋯ menu copies the link and an ffmpeg command.
- **Record the playing video:** collapsed below; opens automatically when nothing on the page is downloadable.
- **Footer:** the **Download button on this site** switch and the save-location button (shows the last folder name; hover for the full path).
- **⚙ Settings:** interface language (English / Tiếng Việt), download button on all sites, save location, simultaneous downloads (1–5), the list of sites where the button is hidden with **Show again**, local YouTube helper status, **Attach subtitles & dubbing** (on by default) and **Keep separate subtitle & dubbing files** (off by default).

### Download Manager

Top bar: **save location** (click to change the folder; ⋯ next to it offers a sub-folder in Downloads and **Ask where to save every time**) · **N at once** · ⏸ **Pause all** / ▶ **Resume all** · 🗑 **Clear** finished items.

Items are grouped into **Downloading / Needs attention / Done**:

| Button | Action |
| --- | --- |
| ⏸ Pause | Stops downloading but keeps what was received; a paused item gives its slot to a waiting one |
| ▶ Resume | Continues from where it stopped (YouTube via the local helper: yt-dlp resumes the `.part` file) |
| ✕ (downloading / queued / paused) | Cancels the download or removes it from the queue |
| Stop & save | For HLS livestreams: stop and save what was downloaded |
| Retry | Re-downloads a failed, cancelled or interrupted item |
| Open folder | Opens File Explorer with the saved file selected (a custom folder needs the local helper, because Chrome does not expose real paths) |
| ✕ (done / error) | Removes the item from the list; **does not delete the file** |

- Click an item's name while queued or downloading to rename the file (no need to type `.mp4`). After saving, the item shows the real file name on disk, including `(1)`, `(2)` suffixes.
- Data is spooled to temporary files on disk, not kept in RAM; saving needs roughly twice the video size free. Temp files are deleted when the item finishes, is cancelled or removed.
- Cannot be paused: HLS livestreams (use **Stop & save**) and in-browser YouTube capture. Files from servers without byte-range support restart from the beginning when resumed.
- **Keep the Download Manager window open until downloads finish.** Closing it stops running items; when reopened they show as "interrupted" with **Retry**.
- Download history (up to 200 items) survives closing and reopening the Download Manager.
- The **Errors** tab collects failed videos: cause, step-by-step log (retries, slow segments, final error; no tokenised links), and **Retry**, **Retry all**, **Copy log** buttons for bug reports.
- Error items say what went wrong (expired link, HTTP 429/5xx, network loss, DRM, disk full, missing write permission…) with the matching action: Open source page, Save again, Save to Downloads, Grant write access, Download in browser, Copy details.

**Save location:** `Downloads/Video Catcher` by default. Any folder can be chosen for direct writing (File System Access API); after restarting the browser you may need to click **Grant write access**. Recordings always go to Downloads.

## YouTube

| | Chrome only (default) | Local helper (yt-dlp + FFmpeg) |
| --- | --- | --- |
| Setup | None | Run `setup-youtube.cmd` once |
| Quality | Up to 1080p, H.264 + AAC | Every level available, up to 4K (1440p/4K are usually AV1) |
| Speed | As fast as the YouTube player loads | Fast, direct download |
| Location | Download Manager's save location | `downloads/` in the project, or the folder chosen at setup |

- The quality list is read from the page as soon as the video loads, so it appears instantly with estimated sizes.
- Only levels with an MP4 rendition are listed; H.264 is preferred, otherwise AV1. Nothing is re-encoded.
- Links with `list=...` download **only the current video**, not the playlist.
- **Chrome-only mode:** the Download Manager opens the video in a new muted tab, captures what the player fetches, then muxes an MP4. The tab closes by itself; you may switch tabs but **do not close the capture tab**. Videos with ads wait for the ads to end. Login-gated videos work if you can watch them.
- If the local helper fails, the error item offers **Download in browser** to fall back to Chrome-only mode.

### Installing the local YouTube helper (optional, Windows x64)

1. Install the extension first (to obtain its ID).
2. Run **`setup-youtube.cmd`** in the project folder.
3. When it prints `YouTube helper ready`, reload the extension and the YouTube page. **Local YouTube helper** in the popup's ⚙ Settings will show it running.

The installer downloads yt-dlp and FFmpeg from yt-dlp's official repositories and verifies SHA-256; it uses an existing Node.js 22+ or downloads Node.js LTS. No Python. The helper registers the Native Messaging host `com.videocatcher.youtube` under **HKCU** in the Registry, allowed only for this extension's ID; it opens no network port and reads no cookies or browser accounts.

`setup-youtube.cmd` runs PowerShell with `-ExecutionPolicy Bypass` for that one run only and does not change the machine's security settings. Always run the `.cmd`, never the `.ps1` directly. Extra parameters:

```powershell
.\setup-youtube.cmd -ExtensionId "32_CHAR_EXTENSION_ID"   # when the ID is not found automatically
.\setup-youtube.cmd -DownloadDir "D:\Videos"              # change the YouTube save folder
```

Re-run the installer after moving the project folder, changing the extension ID, or to update yt-dlp. Check `youtube/host.log` on errors.

Command-line download (after setup):

```powershell
.\youtube\tools\node.exe .\youtube\download.cjs "https://www.youtube.com/watch?v=VIDEO_ID" 1080
```

## Downloading with subtitles & dubbing (Song Ngữ & Thuyết Minh)

Install the companion extension **Song Ngữ & Thuyết Minh** (project "CC and dịch") and enable it on the video. The download menu then shows a **Phụ đề & thuyết minh (CC and dịch)** section; the choices are remembered:

| Option | Values |
| --- | --- |
| **Phụ đề** (subtitle lines) | Gốc (original) · Dịch (translation) · Cả hai (both — follows the companion's display settings, including the phonetic line when enabled) |
| **Ghi phụ đề** (how subtitles are written) | Không (none) · **In cứng vào hình** (burned in — exactly the font size, colours, backgrounds, fonts and position you see while watching; re-encodes video with NVENC when available, otherwise libx264) · **Track phụ đề bật/tắt** (switchable track: mov_text in MP4, SRT in MKV) · Cả hai (both) |
| **Thuyết minh** (dubbing) | Không (none) · **Tiếng gốc** (original audio stays default, dubbing added as a second audio track) · **Tiếng dịch** (dubbing voice only, original audio removed) · **Trộn** (mix: dubbing voice + original audio ducked to the level you configured) |
| **Giọng online** | Shown only when the selected voice is a cloud voice (Gemini, Azure, ElevenLabs…): use it (shows the estimated minutes of quota) or switch to an on-device voice |

Works for every source: YouTube (local helper), HLS/DASH and plain files (Download Manager). Requires the local helper (ffmpeg in `youtube/tools`).

How it runs — everything in parallel:

1. The download item is created immediately and the video starts downloading.
2. In the page, the companion extension finishes translating the remaining sentences and synthesises the full dubbing track sentence by sentence (speech rate adapted and smoothed exactly as during playback, no overlapping sentences); it starts speaking as soon as a sentence is translated. The result — ASS/SRT subtitles, a 22.05 kHz voice WAV and a 1 kHz ducking envelope — is streamed to the local helper in base64 chunks through the service worker (temporary files in `%TEMP%\VideoCatcher\<item id>`; nothing goes through Chrome Downloads, so no "Ask where to save" dialogs).
3. When both are done, the helper merges with ffmpeg (`postprocess` command): the Download Manager shows "Đang ghép phụ đề + thuyết minh… 42%", the merged file replaces the plain one under the same name, temp files are deleted. A merge error never loses the downloaded video; **Bỏ qua** (Skip) stops merging and keeps the plain file.

Settings in the popup: **Kèm phụ đề & thuyết minh** turns the whole section on/off (on by default); **Giữ file phụ đề & thuyết minh rời** keeps `Video.vi.srt`, `Video.vi.ass` and `Video.thuyet-minh.wav` next to the video after merging (off by default — deleted immediately).

On-device voices synthesise 3–10× faster than real time; cloud voices consume quota proportional to the video length. System (Web Speech) voices cannot be captured to a file and are replaced by an on-device voice of the same gender.

## HLS, DASH and plain files

- **HLS / DASH → MP4:** up to 16 segments in parallel, video and audio muxed in the browser. A segment 3× slower than usual (stalled server) gets a second parallel request and the first to finish wins, so other streams never wait; the same for the tail of large files. Supports HLS AES-128, segments disguised as images/PDF, playlists with fake prefixes, playlists generated in the page, fMP4 with separate video/audio. MPEG-TS is remuxed to MP4 with mux.js; if that fails the original TS is saved. DASH WebM is saved as two files with an ffmpeg merge command.
- **MP4/WebM/MP3 files:** multi-connection download (up to 8) when the server supports Range, otherwise single connection; a dropped connection resumes from where it stopped. Servers returning an error page instead of the video (expired link) produce a clear error, not a junk file.
- **HLS livestreams:** downloaded continuously until **Stop & save**.
- **Record:** captureStream + MediaRecorder; takes as long as the video lasts.

## When no source is found

1. Wait for ads to end, let the main video play for a few seconds, then reopen the menu (or press ↻ in the popup).
2. Pick the source whose duration matches the main video; small files are usually ads.
3. For encrypted sources handled by the player, only levels that have been played can be downloaded: select that level in the player, play a few seconds, reopen the menu.
4. Still missing: open **Diagnostics** from the chip at the bottom of the menu. It summarises ✓ fine / ! needs action / ✕ not downloadable with what to do; **Copy report** for bug reports (nothing is sent anywhere automatically).

Once a download is added you can close the video tab: the item carries copies of any playlists the page built, so it still downloads (even while queued or after Retry). **Record** stops when the tab closes, and do not close YouTube's in-browser capture tab. After closing and reopening the Download Manager, an old item can only be retried if its playlist is still reachable; otherwise reopen the page and play the video.

**An error on `chrome://extensions` pointing at `hook.js`:** to catch video links the extension wraps the page's `fetch`. When the page itself issues a request blocked by its own CSP (e.g. Cloudflare's challenge calling `fetch('data:;')`), Chrome attributes the error to the extension because `hook.js` is on the stack. It is harmless, the page keeps working, and it only shows in Developer mode.

## Limitations

- No DRM bypass (Widevine, PlayReady, FairPlay), HLS SAMPLE-AES or DASH ContentProtection.
- YouTube: no livestreams yet. If YouTube asks for verification or changes its playback mechanism the error shows in the Download Manager; not every video is guaranteed to download.
- No DASH livestreams; use Record if the page allows it.
- Some sites block captureStream/CORS, so recording fails.
- MP4 muxed in the browser is fragmented MP4. If an old player cannot open it, normalise with `ffmpeg -i input.mp4 -c copy output.mp4`.
- The download button is not attached to camera or call videos.

## Code layout

```text
manifest.json              Version, permissions, content scripts (MV3)
background.js              Source capture via webRequest, playlist parsing, YouTube info, Download Manager, subtitle/dubbing hand-off
hook.js                    (MAIN world) Catches manifests via Fetch/XHR/Blob/hls.js
content.js                 Download button, quality menu, YouTube buttons, recording, subtitle & dubbing options
popup.html/.css/.js        Popup and Settings
manager.html/.css/.js      Download Manager: queue, parallel download, muxing, saving, history, post-processing
diagnostics.html/.js       Diagnostics page
lib/youtube.js             Reads YouTube quality/size from the page
lib/yt-capture.js          In-tab YouTube capture (only when the URL has #vc-capture)
lib/native-youtube.js      Client for the local helper (download, postprocess, staging)
lib/m3u8.js, mpd.js        HLS / DASH parsers
lib/fmp4.js                fMP4 muxing
lib/mux-mp4.min.js         mux.js 7.0.3 (Apache-2.0), MPEG-TS → MP4
lib/errors.js              Error classification for download cards
lib/i18n.js, lib/locales/  Interface language: VCI18n.t(key, [args]), en.js / vi.js dictionaries, data-i18n for static HTML
lib/position.js, frames.js Button/menu placement, player-iframe detection
setup-youtube.cmd          Local helper installer (Windows)
youtube/native-host.cjs    Local helper: hello / inspect / download / openFolder / reveal / stage* / postprocess
youtube/postprocess.cjs    ffmpeg merge of subtitles & dubbing; receives temp files in base64 chunks
youtube/locate.cjs         Finds a saved file in a custom folder for Open folder
youtube/download.cjs       Command-line YouTube download
tools/i18n-tool.cjs        Extracts Vietnamese strings to tools/i18n/*.json, rewrites code to VCI18n.t(), regenerates lib/locales
tools/test-post.cjs        Post-processing tests (ASS via the companion's export.js, 6 merge modes, keep mode, bad input)
```

Ignored by Git: `youtube/tools/`, `youtube/config.json`, `youtube/host.log`, `downloads/`.

## Development

Node.js 22+, no npm packages. Verify YouTube for real with `youtube/download.cjs`, then inspect the file with `youtube/tools/ffprobe.exe`.

## Translating

Every user-visible string lives in `lib/locales/en.js` and `lib/locales/vi.js`. To change a translation edit `tools/i18n/en.json`
(English) or `tools/i18n/vi.json` (Vietnamese) and run `node tools/i18n-tool.cjs apply`. To add a new string, write it in Vietnamese in
the code or HTML, run `node tools/i18n-tool.cjs extract`, fill the new key in `tools/i18n/en.json`, then `apply`. A third language
needs `lib/locales/<code>.js`, the code in `lib/i18n.js` (`LANGS`) and a button in the popup's language picker.

Post-processing tests (needs ffmpeg in `youtube/tools`): `youtube\tools\node.exe tools\test-post.cjs "..\CC and dich\extension\content\export.js"`.

## Third-party tools

- [yt-dlp](https://github.com/yt-dlp/yt-dlp) and [yt-dlp's FFmpeg builds](https://github.com/yt-dlp/FFmpeg-Builds)
- [Node.js](https://nodejs.org/)
- [Chrome Native Messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)

Only download or record content you own or are allowed to keep.
