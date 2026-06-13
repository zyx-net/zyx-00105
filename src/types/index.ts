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
