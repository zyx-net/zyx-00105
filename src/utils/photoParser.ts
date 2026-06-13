import * as fs from 'fs-extra';
import * as path from 'path';
import { DateTime } from 'luxon';
import { PhotoInfo, Config, PointConfig, NamingRule } from '../types';

export async function extractPhotoMetadata(filePath: string): Promise<{ capturedTime: string; size: number }> {
  const stats = await fs.stat(filePath);
  const capturedTime = DateTime.fromJSDate(stats.mtime).toISO() || DateTime.now().toISO();
  return { capturedTime, size: stats.size };
}

export function generateTargetName(
  point: PointConfig,
  round: number,
  namingRule: NamingRule,
  timestamp?: string
): string {
  const dateStr = timestamp 
    ? DateTime.fromISO(timestamp).toFormat(namingRule.dateFormat)
    : DateTime.now().toFormat(namingRule.dateFormat);
  
  let name = namingRule.pattern
    .replace('{building}', point.building)
    .replace('{floor}', point.floor)
    .replace('{position}', point.position)
    .replace('{round}', String(round))
    .replace('{date}', dateStr)
    .replace('{pointId}', point.id)
    .replace('{pointName}', point.name);
  
  if (name.length > namingRule.maxFileNameLength) {
    name = name.substring(0, namingRule.maxFileNameLength);
  }
  
  return name;
}

export async function scanPhotos(
  inputDir: string,
  config: Config
): Promise<PhotoInfo[]> {
  const photos: PhotoInfo[] = [];
  const allowedExts = config.namingRule.allowedExtensions.map(e => e.toLowerCase());
  
  const files = await fs.readdir(inputDir);
  
  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (!allowedExts.includes(ext)) continue;
    
    const filePath = path.join(inputDir, file);
    const stats = await fs.stat(filePath);
    if (!stats.isFile()) continue;
    
    const { capturedTime, size } = await extractPhotoMetadata(filePath);
    const fileNameWithoutExt = path.basename(file, ext);
    
    let matchedItem = config.inspectionList.find(item => {
      const point = config.points.find(p => p.id === item.pointId);
      if (!point) return false;
      const targetName = generateTargetName(point, item.round, config.namingRule, capturedTime);
      return file.toLowerCase().includes(targetName.toLowerCase());
    });
    
    if (!matchedItem) {
      matchedItem = config.inspectionList.find(item => {
        const point = config.points.find(p => p.id === item.pointId);
        if (!point) return false;
        return fileNameWithoutExt.includes(point.building) &&
               fileNameWithoutExt.includes(point.floor) &&
               fileNameWithoutExt.includes(point.position);
      });
    }
    
    if (!matchedItem) {
      matchedItem = config.inspectionList.find(item => {
        const point = config.points.find(p => p.id === item.pointId);
        if (!point) return false;
        const parts = fileNameWithoutExt.split('-');
        return parts.includes(point.building) || 
               parts.includes(point.floor) || 
               parts.includes(point.position);
      });
    }
    
    if (matchedItem) {
      const point = config.points.find(p => p.id === matchedItem.pointId)!;
      const targetName = generateTargetName(point, matchedItem.round, config.namingRule, capturedTime);
      
      photos.push({
        filePath,
        fileName: file,
        targetName: targetName + ext,
        pointId: matchedItem.pointId,
        batchId: matchedItem.batchId,
        round: matchedItem.round,
        capturedTime,
        size,
      });
    } else {
      photos.push({
        filePath,
        fileName: file,
        targetName: file,
        pointId: 'unknown',
        batchId: 'unknown',
        round: 0,
        capturedTime,
        size,
      });
    }
  }
  
  return photos;
}

export function validateTimeWindow(
  photo: PhotoInfo,
  scheduledTime: string,
  windowMinutes: number
): boolean {
  const photoTime = DateTime.fromISO(photo.capturedTime);
  const scheduled = DateTime.fromISO(scheduledTime);
  const diffMinutes = Math.abs(photoTime.diff(scheduled, 'minutes').minutes);
  return diffMinutes <= windowMinutes;
}
