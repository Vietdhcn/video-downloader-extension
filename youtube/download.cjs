// Optional CLI using the exact same Native Messaging protocol as the extension.
const { spawn } = require('node:child_process');
const path = require('node:path');
const { normalize } = require('../lib/youtube.js');
const { quality } = require('./native-host.cjs');
const url = normalize(process.argv[2]);
if (!url) throw new Error('Usage: node youtube/download.cjs <YouTube URL> [height, default 1080]');
const height = quality(process.argv[3] || 1080);
const child = spawn(process.execPath, [path.join(__dirname, 'native-host.cjs')], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
let buffer = Buffer.alloc(0), success = false, lastProgress = 0;
function post(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  child.stdin.write(Buffer.concat([header, body]));
}
child.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
    const length = buffer.readUInt32LE(0);
    const message = JSON.parse(buffer.subarray(4, length + 4).toString('utf8'));
    buffer = buffer.subarray(length + 4);
    if (message.type === 'info') {
      console.log(`${message.title} · ${message.duration}s · ${message.heights.join(', ')}p`);
      post({ action: 'download', url, height });
    } else if (message.type === 'progress' && Date.now() - lastProgress > 2000) {
      lastProgress = Date.now();
      console.log(`Downloading ${message.total ? Math.round(message.downloaded / message.total * 100) : '?'}%`);
    } else if (message.type === 'done') {
      success = true;
      console.log(`SAVED: ${message.file}\nBYTES: ${message.size}`);
      child.stdin.end();
    } else if (message.type === 'error' || message.type === 'cancelled') {
      console.error(message.error || 'Cancelled');
      child.stdin.end();
    }
  }
});
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('close', () => { if (!success) process.exitCode = 1; });
post({ action: 'inspect', url });
