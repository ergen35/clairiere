// Checks the protection rules of every system, from any system: what may never be deleted on
// Windows, macOS and Linux, and what stays allowed. Pure reasoning on paths, nothing is touched.
// Run after `npm run build`: node scripts/safety-check.mjs
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { refusal, warning } = require(join(dirname(fileURLToPath(import.meta.url)), '..', 'dist-electron', 'electron', 'safety.js'));

let failures = 0;
function expect(name, got, want) {
  const ok = want === 'allowed' ? got === null : want === 'refused' ? got !== null : got === want;
  if (!ok) {
    failures += 1;
    console.log(`FAIL ${name}: got ${got}, want ${want}`);
  }
}

const windows = {
  platform: 'win32',
  home: 'C:\\Users\\Ana',
  mounts: ['C:\\', 'D:\\'],
  appDirs: ['C:\\Users\\Ana\\AppData\\Local\\Programs\\Clairière\\resources\\app', 'C:\\Users\\Ana\\AppData\\Roaming\\Clairière'],
  personal: ['C:\\Users\\Ana\\Documents', 'C:\\Users\\Ana\\Pictures', 'C:\\Users\\Ana\\Desktop'],
  env: { SystemRoot: 'C:\\WINDOWS', SystemDrive: 'C:', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramData: 'C:\\ProgramData' },
};

for (const p of [
  'C:\\', 'D:\\', 'C:\\Windows', 'c:\\windows\\system32\\drivers', 'C:\\Program Files\\Some App', 'C:\\Program Files (x86)\\Steam',
  'C:\\Users', 'C:\\Users\\Ana', 'C:\\Users\\Ana\\AppData', 'C:\\Users\\Ana\\AppData\\Local', 'C:\\Users\\Ana\\AppData\\Roaming',
  'C:\\Users\\Ana\\AppData\\Local\\Temp', 'C:\\$Recycle.Bin\\S-1-5-21', 'D:\\System Volume Information', 'C:\\pagefile.sys',
  'C:\\ProgramData', 'C:\\ProgramData\\Microsoft\\Windows', 'C:\\Users\\Ana\\.ssh\\id_ed25519', 'C:\\Users\\Ana\\NTUSER.DAT',
  'C:\\Users\\Ana\\AppData\\Roaming\\Microsoft\\Credentials\\x', 'C:\\Users\\Ana\\AppData\\Local\\Programs\\Clairière\\resources\\app\\dist',
  'C:\\Users\\Ana\\AppData\\Local\\Programs', 'relative\\path', 'C:\\Users\\Ana\\..\\Bob', '\\\\?\\C:\\Windows', 'C:', 'C:foo', 'C:/Windows/System32',
]) expect(`windows refuses ${p}`, refusal(p, windows), 'refused');

for (const p of [
  'C:\\Users\\Ana\\AppData\\Local\\Temp\\setup-123', 'C:\\Users\\Ana\\Downloads\\big.iso', 'C:\\Users\\Ana\\projects\\site\\node_modules',
  'D:\\Games\\old', 'C:\\Users\\Ana\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Cache', 'C:\\Users\\Ana\\AppData\\Local\\Microsoft\\Windows\\INetCache',
  'C:\\ProgramData\\OldApp', 'C:\\Users\\Ana\\Documents', '\\\\server\\share\\old',
]) expect(`windows allows ${p}`, refusal(p, windows), 'allowed');
expect('windows lets the cleaner empty Temp', refusal('C:\\Users\\Ana\\AppData\\Local\\Temp', windows, true), 'allowed');
expect('windows: Documents is personal', warning('C:\\Users\\Ana\\Documents', windows), 'warn.personal');
expect('windows: a folder holding Pictures is personal', warning('C:\\Users\\Ana', windows), 'warn.personal');
expect('windows: OneDrive is in the cloud', warning('C:\\Users\\Ana\\OneDrive - Work\\Photos', windows), 'warn.cloud');
expect('windows: app settings', warning('C:\\Users\\Ana\\AppData\\Roaming\\SomeApp', windows), 'warn.appSettings');
expect('windows: a download is plain', warning('C:\\Users\\Ana\\Downloads\\big.iso', windows), null);

const mac = {
  platform: 'darwin',
  home: '/Users/ana',
  mounts: ['/', '/Volumes/Backup'],
  appDirs: ['/Applications/Clairière.app/Contents/Resources/app', '/Users/ana/Library/Application Support/Clairière'],
  personal: ['/Users/ana/Documents', '/Users/ana/Pictures', '/Users/ana/Desktop'],
  env: {},
};
for (const p of [
  '/', '/System/Library', '/Applications', '/Library', '/Library/Application Support', '/Users', '/Users/ana', '/users/ANA',
  '/Users/ana/Library', '/Users/ana/Library/Caches', '/Users/ana/Library/Application Support', '/Users/ana/Library/Keychains/login.keychain-db',
  '/private/var/db/x', '/usr/local/bin', '/Volumes/Backup', '/Volumes', '/Users/ana/.Trash', '/Users/ana/.ssh/id_rsa',
  '/Applications/Clairière.app/Contents/Resources/app/engine-bin', '/private/tmp',
]) expect(`mac refuses ${p}`, refusal(p, mac), 'refused');
for (const p of [
  '/Users/ana/Library/Caches/com.spotify.client', '/Applications/Old Game.app', '/Users/ana/Library/Developer/Xcode/DerivedData',
  '/Volumes/Backup/old', '/Users/ana/Downloads/big.dmg', '/Users/ana/Library/Logs/DiagnosticReports',
]) expect(`mac allows ${p}`, refusal(p, mac), 'allowed');
expect('mac lets the cleaner empty Caches', refusal('/Users/ana/Library/Caches', mac, true), 'allowed');
expect('mac: an application', warning('/Applications/Old Game.app', mac), 'warn.application');
expect('mac: app settings', warning('/Users/ana/Library/Application Support/SomeApp', mac), 'warn.appSettings');
expect('mac: iCloud Drive', warning('/Users/ana/Library/Mobile Documents/com~apple~CloudDocs/x', mac), 'warn.cloud');
expect('mac: Documents', warning('/Users/ana/Documents', mac), 'warn.personal');

const linux = {
  platform: 'linux', home: '/home/ana', mounts: ['/', '/media/ana/usb'], appDirs: ['/opt/clairiere/resources/app'],
  personal: ['/home/ana/Documents'], env: {},
};
for (const p of ['/', '/usr', '/etc/passwd', '/home', '/home/ana', '/home/ana/.config', '/home/ana/.cache', '/home/ana/.ssh/id', '/media/ana/usb', '/opt/clairiere/resources/app/dist', 'relative/path'])
  expect(`linux refuses ${p}`, refusal(p, linux), 'refused');
for (const p of ['/home/ana/.cache/pip', '/home/ana/Downloads/x.iso', '/media/ana/usb/old', '/var/tmp/stuff'])
  expect(`linux allows ${p}`, refusal(p, linux), 'allowed');
expect('linux: /Home/ana is another folder (letter case counts)', refusal('/Home/ana/x', linux), 'allowed');

console.log(failures ? `${failures} protection check(s) failed.` : 'All protection checks passed (Windows, macOS, Linux).');
process.exit(failures ? 1 : 0);
