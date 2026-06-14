export interface PointConfig {
  id: string;
  name: string;
  building: string;
  floor: string;
  position: string;
  required: boolean;
  description?: string;
}

export interface NamingRule {
  pattern: string;
  dateFormat: string;
  allowedExtensions: string[];
  maxFileNameLength: number;
}

export interface InspectionItem {
  id: string;
  pointId: string;
  batchId: string;
  round: number;
  scheduledTime: string;
  status: 'pending' | 'completed' | 'rejected' | 'retry';
  rejectReason?: string;
  retryCount: number;
}

export interface PhotoInfo {
  filePath: string;
  fileName: string;
  targetName: string;
  pointId: string;
  batchId: string;
  round: number;
  capturedTime: string;
  size: number;
}

export interface BatchStatus {
  batchId: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'rolled_back';
  createdAt: string;
  completedAt?: string;
  totalPhotos: number;
  successCount: number;
  failedCount: number;
  errors: string[];
  actions: BatchAction[];
  lock?: LockInfo;
}

export interface LockInfo {
  locked: boolean;
  lockedAt?: string;
  lockedBy?: string;
}

export interface IntegrityEntry {
  fileName: string;
  sha256: string;
  size: number;
}

export interface IntegrityRecord {
  batchId: string;
  createdAt: string;
  files: IntegrityEntry[];
}

export interface BatchAction {
  id: string;
  type: 'copy' | 'move' | 'skip' | 'reject';
  sourcePath: string;
  targetPath: string;
  photoInfo: PhotoInfo;
  timestamp: string;
  status: 'success' | 'failed' | 'pending';
  error?: string;
}

export interface DryRunResult {
  missingPoints: string[];
  duplicateTargets: { targetName: string; files: string[] }[];
  extraPhotos: string[];
  timeWindowViolations: { file: string; capturedTime: string; window: string }[];
  directoryConflicts: string[];
  totalPhotos: number;
  validPhotos: number;
}

export interface Config {
  points: PointConfig[];
  namingRule: NamingRule;
  inspectionList: InspectionItem[];
  outputBasePath: string;
  archiveFormat: 'directory' | 'zip';
  timeWindowMinutes: number;
  backupEnabled: boolean;
  backupPath: string;
}

export interface RollbackResult {
  success: boolean;
  message: string;
  restoredFiles: number;
  deletedFiles: number;
  errors: string[];
}

export interface ExportRecord {
  batchId: string;
  photoPath: string;
  targetPath: string;
  pointId: string;
  building: string;
  round: number;
  capturedTime: string;
  status: string;
  actionType: string;
}

export interface ProfileConfig {
  name: string;
  points: PointConfig[];
  namingRule: NamingRule;
  timeWindowMinutes: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileManager {
  currentProfile: string | null;
  profiles: string[];
}

export interface DiffResult {
  batchId1: string;
  batchId2: string;
  comparedAt: string;
  added: DiffEntry[];
  removed: DiffEntry[];
  changed: DiffChangeEntry[];
  summary: DiffSummary;
}

export interface DiffEntry {
  pointId: string;
  fileName: string;
  targetPath: string;
  size: number;
  capturedTime: string;
}

export interface DiffChangeEntry extends DiffEntry {
  oldSize: number;
  newSize: number;
  sizeDiff: number;
  oldCapturedTime: string;
  newCapturedTime: string;
  timeDiff: string;
}

export interface DiffSummary {
  totalAdded: number;
  totalRemoved: number;
  totalChanged: number;
  totalUnchanged: number;
}
