// Everything the window and the desktop side exchange.
import type { Lang } from './i18n';

export interface DiskInfo {
  id: string;
  device: string;
  mount: string;
  fstype: string;
  label: string;
  detail: string;
  total: number;
  used: number;
  free: number;
  system: boolean;
}

export interface ScanProgress {
  files: number;
  dirs: number;
  bytes: number;
  errors: number;
  ms: number;
  current: string;
  top: { name: string; bytes: number }[];
}

export interface TopFile {
  path: string;
  size: number;
  mtime: number;
  lossy: boolean;
}

export type ArtefactKind = 'node' | 'rust' | 'python' | 'web' | 'gradle' | 'tools';

export interface Artefact {
  id: number;
  path: string;
  kind: ArtefactKind;
  bytes: number;
  files: number;
  mtime: number;
  lossy: boolean;
}

export interface ScanResult {
  root: string;
  bytes: number;
  files: number;
  dirs: number;
  errors: number;
  ms: number;
  topFiles: TopFile[];
  artefacts: Artefact[];
  denied: string[];
  skippedMounts: string[];
  /** How much the disk says is in use, when the whole disk was analysed. */
  diskUsed?: number;
}

export interface TreeNode {
  id?: number;
  name: string;
  kind: 'dir' | 'file' | 'other';
  size: number;
  files?: number;
  dirs?: number;
  mtime?: number;
  denied?: boolean;
  lossy?: boolean;
  hasChildren?: boolean;
  count?: number;
  children?: TreeNode[];
}

export interface ViewResult {
  path: string;
  pathLossy: boolean;
  ancestors: { id: number; name: string }[];
  node: TreeNode;
}

export interface ViewOptions {
  depth: number;
  minBytes?: number;
  maxChildren?: number;
  budget?: number;
}

export interface DeleteItem {
  path: string;
  size: number;
}

export type DeleteMode = 'trash' | 'permanent';

export interface ItemCheck {
  path: string;
  refused?: string;
  warning?: string;
}

export interface DeleteOutcome {
  mode: DeleteMode;
  /** Space really given back to the disk. */
  freed: number;
  /** Space moved to the bin, which only comes back once the bin is emptied. */
  moved: number;
  done: string[];
  failed: { path: string; reason: string }[];
  summary?: Pick<ScanResult, 'bytes' | 'files' | 'dirs' | 'topFiles' | 'artefacts'>;
}

export type TargetGroup = 'quick' | 'browsers' | 'apps' | 'dev' | 'system' | 'custom';

export interface CleanTarget {
  id: string;
  group: TargetGroup;
  label: string;
  hint: string;
  /** safe: rebuilt on its own. review: worth a look first (bin, big downloads, your own folders). */
  risk: 'safe' | 'review';
  needsPassword: boolean;
  /** Program that should be closed first, when it is open. */
  blockedBy?: string;
  selected: boolean;
  bytes: number | null;
  files: number | null;
  paths: string[];
}

export interface TargetMeasure {
  id: string;
  bytes: number;
  files: number | null;
  unknown?: boolean;
}

export interface CleanProgress {
  targetId: string;
  label: string;
  freed: number;
  index: number;
  count: number;
}

export interface CleanOutcome {
  freed: number;
  ms: number;
  cancelled: boolean;
  results: { id: string; label: string; freed: number; note?: string }[];
}

export interface CleanStats {
  totalFreed: number;
  lastCleanAt: number | null;
  lastFreed: number;
  autoClean: boolean;
}

export type Platform = 'linux' | 'darwin' | 'win32';

export interface Api {
  isDemo: boolean;
  platform(): Promise<Platform>;
  /** The language chosen by the person, or null before the first choice. */
  getLanguage(): Promise<Lang | null>;
  setLanguage(lang: Lang): Promise<void>;
  /** macOS: the Privacy settings page where full disk access is granted. */
  openDiskAccessSettings(): Promise<void>;
  home(): Promise<string>;
  disks(): Promise<DiskInfo[]>;
  scan(path: string, onProgress: (p: ScanProgress) => void): Promise<ScanResult>;
  cancelScan(): Promise<void>;
  view(node: number, options: ViewOptions): Promise<ViewResult>;
  pickFolder(): Promise<string | null>;
  checkItems(paths: string[]): Promise<ItemCheck[]>;
  deleteItems(items: DeleteItem[], mode: DeleteMode): Promise<DeleteOutcome>;
  open(path: string): Promise<void>;
  reveal(path: string): Promise<void>;
  copyPath(path: string): Promise<void>;
  cleanTargets(): Promise<CleanTarget[]>;
  measureTargets(onMeasure: (m: TargetMeasure) => void): Promise<void>;
  setTargetSelected(id: string, selected: boolean): Promise<void>;
  cleanRun(ids: string[], onProgress: (p: CleanProgress) => void): Promise<CleanOutcome>;
  cancelClean(): Promise<void>;
  addCustomTarget(path: string): Promise<string | null>;
  removeCustomTarget(id: string): Promise<void>;
  stats(): Promise<CleanStats>;
  setAutoClean(on: boolean): Promise<void>;
  runAutoClean(): Promise<CleanOutcome | null>;
  findProjects(): Promise<Artefact[]>;
  launcherInstalled(): Promise<boolean>;
  installLauncher(): Promise<void>;
  openLink(url: string): Promise<void>;
}
