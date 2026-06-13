import * as fs from 'fs-extra';
import * as path from 'path';
import { Config, PhotoInfo, DryRunResult, PointConfig } from '../types';
import { scanPhotos, validateTimeWindow } from '../utils/photoParser';

export async function performDryRun(
  inputDir: string,
  config: Config
): Promise<DryRunResult> {
  const result: DryRunResult = {
    missingPoints: [],
    duplicateTargets: [],
    extraPhotos: [],
    timeWindowViolations: [],
    directoryConflicts: [],
    totalPhotos: 0,
    validPhotos: 0,
  };

  const photos = await scanPhotos(inputDir, config);
  result.totalPhotos = photos.length;

  const batchItems = config.inspectionList.filter(item => item.status !== 'completed');
  
  const requiredPoints = config.points
    .filter(p => p.required)
    .map(p => p.id);

  const coveredPoints = new Set<string>();
  const targetNameMap = new Map<string, string[]>();

  for (const photo of photos) {
    if (photo.pointId === 'unknown') {
      result.extraPhotos.push(photo.filePath);
      continue;
    }

    coveredPoints.add(photo.pointId);

    const existing = targetNameMap.get(photo.targetName) || [];
    existing.push(photo.filePath);
    targetNameMap.set(photo.targetName, existing);

    const item = batchItems.find(i => i.pointId === photo.pointId);
    if (item && !validateTimeWindow(photo, item.scheduledTime, config.timeWindowMinutes)) {
      result.timeWindowViolations.push({
        file: photo.filePath,
        capturedTime: photo.capturedTime,
        window: `${config.timeWindowMinutes}分钟`,
      });
    }
  }

  for (const requiredId of requiredPoints) {
    if (!coveredPoints.has(requiredId)) {
      const point = config.points.find(p => p.id === requiredId);
      result.missingPoints.push(`${point?.building}-${point?.floor}-${point?.position} (${requiredId})`);
    }
  }

  for (const [targetName, files] of targetNameMap) {
    if (files.length > 1) {
      result.duplicateTargets.push({ targetName, files });
    }
  }

  const outputDir = path.join(config.outputBasePath, 'archive');
  if (await fs.pathExists(outputDir)) {
    const existingFiles = await fs.readdir(outputDir);
    if (existingFiles.length > 0) {
      result.directoryConflicts.push(outputDir);
    }
  }

  result.validPhotos = photos.length - result.extraPhotos.length;

  return result;
}

export function formatDryRunReport(result: DryRunResult): string {
  let report = `\n=== Dry Run 检测报告 ===\n\n`;
  
  report += `总照片数: ${result.totalPhotos}\n`;
  report += `有效照片数: ${result.validPhotos}\n`;
  report += `清单外照片: ${result.extraPhotos.length}\n`;
  report += `时间超窗: ${result.timeWindowViolations.length}\n`;
  report += `重复目标名: ${result.duplicateTargets.length}\n`;
  report += `目录冲突: ${result.directoryConflicts.length}\n`;

  if (result.missingPoints.length > 0) {
    report += `\n【缺拍点位】\n`;
    report += result.missingPoints.map(p => `  - ${p}`).join('\n');
  }

  if (result.duplicateTargets.length > 0) {
    report += `\n【重复目标名】\n`;
    for (const dup of result.duplicateTargets) {
      report += `  目标: ${dup.targetName}\n`;
      report += `  文件: ${dup.files.join(', ')}\n`;
    }
  }

  if (result.extraPhotos.length > 0) {
    report += `\n【清单外照片】\n`;
    report += result.extraPhotos.map(f => `  - ${f}`).join('\n');
  }

  if (result.timeWindowViolations.length > 0) {
    report += `\n【拍摄时间超窗】\n`;
    for (const violation of result.timeWindowViolations) {
      report += `  文件: ${violation.file}\n`;
      report += `  拍摄时间: ${violation.capturedTime}\n`;
      report += `  允许窗口: ${violation.window}\n`;
    }
  }

  if (result.directoryConflicts.length > 0) {
    report += `\n【目录冲突】\n`;
    report += result.directoryConflicts.map(d => `  - ${d}`).join('\n');
  }

  const hasErrors = result.missingPoints.length > 0 || 
                   result.directoryConflicts.length > 0 ||
                   result.duplicateTargets.length > 0;
  
  report += `\n${hasErrors ? '❌ 存在阻止归档的错误' : '✅ 可以继续执行归档'}\n`;
  
  return report;
}
