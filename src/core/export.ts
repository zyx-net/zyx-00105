import * as fs from 'fs-extra';
import * as path from 'path';
import { stringify } from 'csv-stringify/sync';
import { BatchStatus, ExportRecord } from '../types';
import { listBatches } from './archive';

export async function exportBatchRecords(
  outputPath: string,
  format: 'json' | 'csv',
  basePath: string,
  batchId?: string
): Promise<string> {
  let batches: BatchStatus[];

  if (batchId) {
    const batchDir = path.join(basePath, 'batches', batchId);
    if (!await fs.pathExists(batchDir)) {
      throw new Error(`批次 ${batchId} 不存在`);
    }
    const content = await fs.readFile(path.join(batchDir, 'status.json'), 'utf-8');
    batches = [JSON.parse(content)];
  } else {
    batches = await listBatches(basePath);
  }

  const records: ExportRecord[] = [];

  for (const batch of batches) {
    for (const action of batch.actions) {
      const pointId = action.photoInfo.pointId;
      const building = action.photoInfo.targetName.split('-')[0] || '';
      
      records.push({
        batchId: batch.batchId,
        photoPath: action.sourcePath,
        targetPath: action.targetPath,
        pointId,
        building,
        round: action.photoInfo.round,
        capturedTime: action.photoInfo.capturedTime,
        status: action.status,
        actionType: action.type,
      });
    }
  }

  if (format === 'json') {
    const jsonContent = JSON.stringify(records, null, 2);
    await fs.writeFile(outputPath, jsonContent);
    return `已导出 ${records.length} 条记录到 JSON 文件`;
  } else {
    const headers = [
      'batchId', 'photoPath', 'targetPath', 'pointId', 
      'building', 'round', 'capturedTime', 'status', 'actionType'
    ];
    const csvContent = stringify(records, { header: true, columns: headers });
    await fs.writeFile(outputPath, csvContent);
    return `已导出 ${records.length} 条记录到 CSV 文件`;
  }
}
