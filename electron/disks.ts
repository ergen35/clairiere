// The disks of this computer, the way each system describes them.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import path from 'node:path';
import type { DiskInfo } from '../shared/types';
import { tr } from './i18n';

const OS = process.platform;

export interface Mount {
  mount: string;
  device: string;
  fstype: string;
}

// ----- Linux ------------------------------------------------------------------------
const NETWORK_FS = /^(nfs|nfs4|cifs|smb3|sshfs|fuse\.sshfs|9p)$/;

function unescapeMount(s: string) {
  return s.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

function linuxMounts(): Mount[] {
  const out = new Map<string, Mount>();
  let text = '';
  try {
    text = readFileSync('/proc/self/mountinfo', 'utf8');
  } catch {
    return [];
  }
  for (const line of text.split('\n')) {
    const [left, right] = line.split(' - ');
    if (!right) continue;
    const a = left.split(' ');
    const [fstype, device] = right.split(' ');
    const mount = unescapeMount(a[4]);
    if (!device.startsWith('/dev/') || device.startsWith('/dev/loop') || fstype === 'squashfs' || NETWORK_FS.test(fstype)) continue;
    if (a[3] !== '/' && fstype !== 'btrfs') continue; // A folder bound elsewhere, not a disk.
    const seen = out.get(device);
    if (!seen || mount.length < seen.mount.length) out.set(device, { mount, device, fstype });
  }
  return [...out.values()];
}

interface BlockInfo {
  path: string;
  label: string | null;
  model: string | null;
  children?: BlockInfo[];
}

function linuxNames(): Map<string, { label: string | null; model: string | null }> {
  const out = new Map<string, { label: string | null; model: string | null }>();
  try {
    const raw = execFileSync('lsblk', ['-J', '-o', 'PATH,LABEL,MODEL'], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] });
    const walk = (list: BlockInfo[], model: string | null) => {
      for (const b of list) {
        const m = b.model ?? model;
        out.set(b.path, { label: b.label, model: m });
        if (b.children) walk(b.children, m);
      }
    };
    walk(JSON.parse(raw).blockdevices ?? [], null);
  } catch {
    // Friendly names are a nicety: fall back to the mount point.
  }
  return out;
}

// ----- macOS ------------------------------------------------------------------------
/** "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)" */
function macMounts(): Mount[] {
  let text = '';
  try {
    text = execFileSync('/sbin/mount', [], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return [{ mount: '/', device: '/', fstype: 'apfs' }];
  }
  const out: Mount[] = [];
  for (const line of text.split('\n')) {
    const m = /^(.+?) on (.+) \(([^,)]+)/.exec(line);
    if (!m) continue;
    const [, device, mount, fstype] = m;
    if (!device.startsWith('/dev/disk')) continue;
    // The hidden parts of the system disk (its data, its updates, its memory) are counted with "/".
    if (mount.startsWith('/System/Volumes/') || mount.startsWith('/Library/Developer/CoreSimulator/') || mount.startsWith('/private/var/')) continue;
    out.push({ mount, device, fstype });
  }
  return out.length ? out : [{ mount: '/', device: '/', fstype: 'apfs' }];
}

// ----- Windows ----------------------------------------------------------------------
interface WinVolume {
  DeviceID: string;
  VolumeName: string | null;
  DriveType: number;
  FileSystem: string | null;
}

let winVolumes: Map<string, WinVolume> | null = null;
let winVolumesAsked = false;

/** Names of the drives, asked once to the system (it takes about a second). */
function askWindowsVolumes(): Promise<void> {
  if (winVolumesAsked) return Promise.resolve();
  winVolumesAsked = true;
  return new Promise((done) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,VolumeName,DriveType,FileSystem | ConvertTo-Json -Compress'],
      { timeout: 8000, windowsHide: true },
      (error, stdout) => {
        if (!error) {
          try {
            const parsed = JSON.parse(String(stdout));
            const list: WinVolume[] = Array.isArray(parsed) ? parsed : [parsed];
            winVolumes = new Map(list.map((v) => [v.DeviceID.toUpperCase(), v]));
          } catch {
            // Keep the plain drive letters.
          }
        }
        done();
      },
    );
  });
}

function windowsMounts(): Mount[] {
  const out: Mount[] = [];
  for (let c = 67; c <= 90; c += 1) {
    const letter = `${String.fromCharCode(c)}:`;
    const v = winVolumes?.get(letter);
    // 4 is a network share and 5 a CD: neither is worth analysing for space.
    if (v && (v.DriveType === 4 || v.DriveType === 5)) continue;
    if (!v && !existsSync(`${letter}\\`)) continue;
    out.push({ mount: `${letter}\\`, device: letter, fstype: v?.FileSystem ?? '' });
  }
  return out;
}

// ----- Everywhere -------------------------------------------------------------------
export function readMounts(): Mount[] {
  if (OS === 'win32') return windowsMounts();
  if (OS === 'darwin') return macMounts();
  return linuxMounts();
}

/** The disk the system runs from. */
export function systemMount(): string {
  if (OS === 'win32') return `${(process.env.SystemDrive || 'C:').toUpperCase()}\\`;
  return '/';
}

export async function listDisks(): Promise<DiskInfo[]> {
  if (OS === 'win32') await askWindowsVolumes();
  const names = OS === 'linux' ? linuxNames() : new Map<string, { label: string | null; model: string | null }>();
  const sysMount = systemMount();
  const disks: DiskInfo[] = [];
  for (const m of readMounts()) {
    try {
      const s = await statfs(m.mount);
      const total = s.blocks * s.bsize;
      if (total === 0) continue;
      const free = s.bavail * s.bsize;
      // APFS shares one container between volumes: what is not free is in use, whichever volume holds it.
      const used = OS === 'darwin' ? total - free : (s.blocks - s.bfree) * s.bsize;
      const system = m.mount === sysMount;
      let label: string;
      let detail: string;
      if (OS === 'win32') {
        const v = winVolumes?.get(m.device.toUpperCase());
        label = v?.VolumeName || (system ? tr('disk.system') : m.device);
        detail = [m.device, v?.FileSystem].filter(Boolean).join(' · ');
      } else if (OS === 'darwin') {
        label = system ? tr('disk.system') : path.basename(m.mount) || m.mount;
        detail = m.fstype.toUpperCase();
      } else {
        const info = names.get(m.device);
        const tail = m.mount.split('/').pop() || m.mount;
        label = info?.label || (system ? tr('disk.system') : m.mount === '/boot/efi' || m.mount === '/boot' ? tr('disk.boot') : tail);
        detail = info?.model?.trim() || m.device;
      }
      disks.push({ id: m.device + m.mount, device: m.device, mount: m.mount, fstype: m.fstype, label, detail, total, used, free, system });
    } catch {
      // Disk went away while listing it, or an empty card reader.
    }
  }
  return disks.sort((a, b) => Number(b.system) - Number(a.system) || b.total - a.total);
}

export async function diskFree(p: string): Promise<number> {
  try {
    const s = await statfs(p);
    return s.bavail * s.bsize;
  } catch {
    return 0;
  }
}
