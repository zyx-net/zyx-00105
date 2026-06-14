#!/usr/bin/env node

const fs = require('fs-extra');
const path = require('path');

const { loadConfig } = require('./dist/config/loader');
const { performDryRun } = require('./dist/core/dryRun');
const { executeArchive, loadBatchStatus, verifyIntegrity, listBatches } = require('./dist/core/archive');
const { rollbackBatch } = require('./dist/core/rollback');
const { purgeOldBatches } = require('./dist/core/purge');
const { 
  initProfile, 
  listProfiles, 
  switchProfile, 
  deleteProfile, 
  loadProfile,
  listProfilesWithDetails 
} = require('./dist/core/profile');
const { compareBatches, formatDiffReport } = require('./dist/core/diff');
const { scanWorkspace } = require('./dist/core/scan');
const { 
  generateReport,
  formatReportSummary
} = require('./dist/core/report');

const TEST_DIR = path.join(__dirname, 'test_regression');
const EXAMPLES_DIR = path.join(__dirname, 'examples');

async function setup() {
  await fs.remove(TEST_DIR);
  await fs.ensureDir(TEST_DIR);
  
  const inputDir = path.join(TEST_DIR, 'photos');
  const outputDir = path.join(TEST_DIR, 'output');
  
  await fs.ensureDir(inputDir);
  
  await fs.writeFile(path.join(inputDir, '1栋-1层-消防栓-1-20240101-080000.jpg'), 'test-photo-1');
  await fs.writeFile(path.join(inputDir, '1栋-1层-电梯厅-1-20240101-081500.jpg'), 'test-photo-2');
  await fs.writeFile(path.join(inputDir, '2栋-1层-消防栓-1-20240101-090000.jpg'), 'test-photo-3');
  await fs.writeFile(path.join(inputDir, '2栋-1层-电梯厅-1-20240101-091500.jpg'), 'test-photo-4');
  
  return { inputDir, outputDir };
}

async function cleanup() {
  await fs.remove(TEST_DIR);
}

async function testDryRunNoDirectoryCreation() {
  console.log('\n=== Test 1: dry-run should NOT create output directory ===');
  
  const { inputDir, outputDir } = await setup();
  
  try {
    const config = await loadConfig({
      pointConfigPath: path.join(EXAMPLES_DIR, 'points.json'),
      namingRulePath: path.join(EXAMPLES_DIR, 'naming.json'),
      inspectionListPath: path.join(EXAMPLES_DIR, 'inspection.csv'),
      outputBasePath: outputDir,
      createOutputDir: false,
    });

    await performDryRun(inputDir, config);

    const outputExists = await fs.pathExists(outputDir);
    
    if (outputExists) {
      const contents = await fs.readdir(outputDir);
      if (contents.length > 0) {
        console.log('❌ FAILED: dry-run created files in output directory');
        console.log('   Contents:', contents);
        return false;
      }
    }
    
    console.log('✅ PASSED: dry-run did not create output directory');
    return true;
    
  } finally {
    await cleanup();
  }
}

async function testRollbackWithUnrelatedFiles() {
  console.log('\n=== Test 2: rollback should fail when unrelated files exist ===');
  
  const { inputDir, outputDir } = await setup();
  
  try {
    const config = await loadConfig({
      pointConfigPath: path.join(EXAMPLES_DIR, 'points.json'),
      namingRulePath: path.join(EXAMPLES_DIR, 'naming.json'),
      inspectionListPath: path.join(EXAMPLES_DIR, 'inspection.csv'),
      outputBasePath: outputDir,
      createOutputDir: true,
    });

    const status = await executeArchive(inputDir, config);
    console.log(`   Archive completed with batch ID: ${status.batchId}`);

    const unrelatedDir = path.join(outputDir, 'archive', '1栋', '1层-消防栓');
    const unrelatedFile = path.join(unrelatedDir, 'important_user_file.txt');
    await fs.writeFile(unrelatedFile, 'This is an important user file that should not be deleted!');
    
    console.log(`   Created unrelated file: ${unrelatedFile}`);

    const result = await rollbackBatch(status.batchId, outputDir);

    const batchStatus = await loadBatchStatus(status.batchId, outputDir);
    
    if (result.success) {
      console.log('❌ FAILED: rollback succeeded when it should have failed due to unrelated files');
      return false;
    }

    if (batchStatus && batchStatus.status === 'rolled_back') {
      console.log('❌ FAILED: batch status was marked as rolled_back even though it failed');
      return false;
    }

    const unrelatedFileExists = await fs.pathExists(unrelatedFile);
    if (!unrelatedFileExists) {
      console.log('❌ FAILED: unrelated file was deleted despite conflict');
      return false;
    }
    
    console.log('✅ PASSED: rollback correctly detected conflict and preserved unrelated file');
    console.log(`   Error message preview: ${result.message.substring(0, 100)}...`);
    return true;
    
  } finally {
    await cleanup();
  }
}

async function testRollbackWithFileMismatch() {
  console.log('\n=== Test 3: rollback should fail when file size changed ===');
  
  const { inputDir, outputDir } = await setup();
  
  try {
    const config = await loadConfig({
      pointConfigPath: path.join(EXAMPLES_DIR, 'points.json'),
      namingRulePath: path.join(EXAMPLES_DIR, 'naming.json'),
      inspectionListPath: path.join(EXAMPLES_DIR, 'inspection.csv'),
      outputBasePath: outputDir,
      createOutputDir: true,
    });

    const status = await executeArchive(inputDir, config);
    console.log(`   Archive completed with batch ID: ${status.batchId}`);

    const archivedFile = path.join(outputDir, 'archive', '1栋', '1层-消防栓');
    const files = await fs.readdir(archivedFile);
    const targetFile = path.join(archivedFile, files[0]);
    
    await fs.writeFile(targetFile, 'modified content to change size');
    console.log(`   Modified archived file to change its size: ${targetFile}`);

    const result = await rollbackBatch(status.batchId, outputDir);

    const batchStatus = await loadBatchStatus(status.batchId, outputDir);
    
    if (result.success) {
      console.log('❌ FAILED: rollback succeeded when file size mismatch detected');
      return false;
    }

    if (batchStatus && batchStatus.status === 'rolled_back') {
      console.log('❌ FAILED: batch status was marked as rolled_back despite file mismatch');
      return false;
    }
    
    console.log('✅ PASSED: rollback correctly detected file size mismatch');
    console.log(`   Error message preview: ${result.message.substring(0, 100)}...`);
    return true;
    
  } finally {
    await cleanup();
  }
}

async function collectAllFiles(dir) {
  const allFiles = [];
  const items = await fs.readdir(dir);
  for (const item of items) {
    const fullPath = path.join(dir, item);
    const stat = await fs.stat(fullPath);
    if (stat.isDirectory()) {
      const subFiles = await collectAllFiles(fullPath);
      allFiles.push(...subFiles);
    } else {
      allFiles.push(fullPath);
    }
  }
  return allFiles;
}

async function testSuccessfulRollbackAfterCleanup() {
  console.log('\n=== Test 4: rollback should succeed when no conflicts ===');
  
  const { inputDir, outputDir } = await setup();
  
  try {
    const config = await loadConfig({
      pointConfigPath: path.join(EXAMPLES_DIR, 'points.json'),
      namingRulePath: path.join(EXAMPLES_DIR, 'naming.json'),
      inspectionListPath: path.join(EXAMPLES_DIR, 'inspection.csv'),
      outputBasePath: outputDir,
      createOutputDir: true,
    });

    const status = await executeArchive(inputDir, config);
    console.log(`   Archive completed with batch ID: ${status.batchId}`);

    const result = await rollbackBatch(status.batchId, outputDir);

    const batchStatus = await loadBatchStatus(status.batchId, outputDir);
    
    if (!result.success) {
      console.log('❌ FAILED: rollback failed when no conflicts existed');
      return false;
    }

    if (!batchStatus || batchStatus.status !== 'rolled_back') {
      console.log('❌ FAILED: batch status was not updated to rolled_back');
      return false;
    }
    
    const archiveDir = path.join(outputDir, 'archive');
    const archiveExists = await fs.pathExists(archiveDir);
    if (archiveExists) {
      const allFiles = await collectAllFiles(archiveDir);
      const remainingFiles = allFiles.filter(f => !f.includes('batches') && !f.includes('.backup'));
      if (remainingFiles.length > 0) {
        console.log('❌ FAILED: archive files were not deleted');
        return false;
      }
    }
    
    console.log('✅ PASSED: rollback succeeded and deleted archived files');
    return true;
    
  } finally {
    await cleanup();
  }
}

async function testPurgeKeepsRecentBatches() {
  console.log('\n=== Test 5: purge should keep recent batches ===');
  
  const { inputDir, outputDir } = await setup();
  
  try {
    const batchIds = [];
    for (let i = 0; i < 5; i++) {
      const archiveDir = path.join(outputDir, 'archive');
      await fs.remove(archiveDir);
      
      const config = await loadConfig({
        pointConfigPath: path.join(EXAMPLES_DIR, 'points.json'),
        namingRulePath: path.join(EXAMPLES_DIR, 'naming.json'),
        inspectionListPath: path.join(EXAMPLES_DIR, 'inspection.csv'),
        outputBasePath: outputDir,
        createOutputDir: true,
      });
      
      const status = await executeArchive(inputDir, config);
      batchIds.push(status.batchId);
      await new Promise(r => setTimeout(r, 10));
    }
    console.log(`   Created ${batchIds.length} batches`);

    const result = await purgeOldBatches(outputDir, undefined, 2);
    console.log(`   Purge result: ${result.message}`);

    if (!result.success) {
      console.log('❌ FAILED: purge returned failure');
      return false;
    }

    if (result.deletedBatches.length !== 3) {
      console.log(`❌ FAILED: expected 3 deleted batches, got ${result.deletedBatches.length}`);
      return false;
    }

    if (result.skippedBatches.length !== 0) {
      console.log(`❌ FAILED: expected 0 skipped batches, got ${result.skippedBatches.length}`);
      return false;
    }

    const remainingBatches = await listBatches(outputDir);
    if (remainingBatches.length !== 2) {
      console.log(`❌ FAILED: expected 2 remaining batches, got ${remainingBatches.length}`);
      return false;
    }

    const remainingIds = new Set(remainingBatches.map(b => b.batchId));
    const expectedKeep = batchIds.slice(-2);
    for (const id of expectedKeep) {
      if (!remainingIds.has(id)) {
        console.log(`❌ FAILED: expected to keep batch ${id}`);
        return false;
      }
    }

    console.log('✅ PASSED: purge correctly kept recent batches');
    return true;
    
  } finally {
    await cleanup();
  }
}

async function testRollbackWithLockConflict() {
  console.log('\n=== Test 6: rollback should fail when batch is locked ===');
  
  const { inputDir, outputDir } = await setup();
  
  try {
    const config = await loadConfig({
      pointConfigPath: path.join(EXAMPLES_DIR, 'points.json'),
      namingRulePath: path.join(EXAMPLES_DIR, 'naming.json'),
      inspectionListPath: path.join(EXAMPLES_DIR, 'inspection.csv'),
      outputBasePath: outputDir,
      createOutputDir: true,
    });

    const status = await executeArchive(inputDir, config);
    console.log(`   Archive completed with batch ID: ${status.batchId}`);

    const batchDir = path.join(outputDir, 'batches', status.batchId);
    const statusPath = path.join(batchDir, 'status.json');
    const currentStatus = await fs.readJson(statusPath);
    currentStatus.lock = { locked: true, lockedAt: new Date().toISOString(), lockedBy: 'test' };
    await fs.writeJson(statusPath, currentStatus);
    console.log(`   Manually locked batch`);

    const result = await rollbackBatch(status.batchId, outputDir);

    if (result.success) {
      console.log('❌ FAILED: rollback succeeded when batch is locked');
      return false;
    }

    if (!result.message.includes('锁定')) {
      console.log(`❌ FAILED: error message does not mention lock: ${result.message}`);
      return false;
    }

    console.log('✅ PASSED: rollback correctly rejected due to lock conflict');
    return true;
    
  } finally {
    await cleanup();
  }
}

async function testIntegrityCheckFail() {
  console.log('\n=== Test 7: integrity check should fail when file modified ===');
  
  const { inputDir, outputDir } = await setup();
  
  try {
    const config = await loadConfig({
      pointConfigPath: path.join(EXAMPLES_DIR, 'points.json'),
      namingRulePath: path.join(EXAMPLES_DIR, 'naming.json'),
      inspectionListPath: path.join(EXAMPLES_DIR, 'inspection.csv'),
      outputBasePath: outputDir,
      createOutputDir: true,
    });

    const status = await executeArchive(inputDir, config);
    console.log(`   Archive completed with batch ID: ${status.batchId}`);

    const backupDir = path.join(outputDir, '.backup', status.batchId);
    const files = await fs.readdir(backupDir);
    const photoFile = files.find(f => f.endsWith('.jpg'));
    
    if (photoFile) {
      const photoPath = path.join(backupDir, photoFile);
      await fs.writeFile(photoPath, 'modified content that changes hash');
      console.log(`   Modified backup file: ${photoFile}`);
    } else {
      console.log('❌ FAILED: no backup file found');
      return false;
    }

    const backupPath = path.join(outputDir, '.backup');
    const integrity = await verifyIntegrity(status.batchId, backupPath);

    if (integrity.valid) {
      console.log('❌ FAILED: integrity check passed when file was modified');
      return false;
    }

    if (integrity.errors.length === 0) {
      console.log('❌ FAILED: no errors reported for modified file');
      return false;
    }

    console.log(`✅ PASSED: integrity check correctly detected hash mismatch`);
    console.log(`   Error: ${integrity.errors[0]}`);
    return true;
    
  } finally {
    await cleanup();
  }
}

async function testPurgeSkipsRunningBatches() {
  console.log('\n=== Test 8: purge should skip running batches ===');
  
  const { inputDir, outputDir } = await setup();
  
  try {
    const batchIds = [];
    for (let i = 0; i < 3; i++) {
      const archiveDir = path.join(outputDir, 'archive');
      await fs.remove(archiveDir);
      
      const config = await loadConfig({
        pointConfigPath: path.join(EXAMPLES_DIR, 'points.json'),
        namingRulePath: path.join(EXAMPLES_DIR, 'naming.json'),
        inspectionListPath: path.join(EXAMPLES_DIR, 'inspection.csv'),
        outputBasePath: outputDir,
        createOutputDir: true,
      });
      
      const status = await executeArchive(inputDir, config);
      batchIds.push(status.batchId);
    }
    console.log(`   Created ${batchIds.length} batches`);

    const runningBatchDir = path.join(outputDir, 'batches', batchIds[0]);
    const runningStatusPath = path.join(runningBatchDir, 'status.json');
    const runningStatus = await fs.readJson(runningStatusPath);
    runningStatus.status = 'running';
    runningStatus.lock = { locked: true, lockedAt: new Date().toISOString(), lockedBy: 'archive' };
    await fs.writeJson(runningStatusPath, runningStatus);
    console.log(`   Set first batch as running/locked`);

    const result = await purgeOldBatches(outputDir, undefined, 1);
    console.log(`   Purge result: ${result.message}`);

    if (result.skippedBatches.length !== 1) {
      console.log(`❌ FAILED: expected 1 skipped batch, got ${result.skippedBatches.length}`);
      return false;
    }

    if (!result.skippedBatches.includes(batchIds[0])) {
      console.log(`❌ FAILED: running batch was not skipped`);
      return false;
    }

    const remainingBatches = await listBatches(outputDir);
    if (remainingBatches.length !== 2) {
      console.log(`❌ FAILED: expected 2 remaining batches, got ${remainingBatches.length}`);
      return false;
    }

    console.log('✅ PASSED: purge correctly skipped running batch');
    return true;
    
  } finally {
    await cleanup();
  }
}

async function testProfileSwitchWithRunningBatch() {
  console.log('\n=== Test 9: profile switch should fail when there are running batches ===');
  
  const { inputDir, outputDir } = await setup();
  
  try {
    const config = await loadConfig({
      pointConfigPath: path.join(EXAMPLES_DIR, 'points.json'),
      namingRulePath: path.join(EXAMPLES_DIR, 'naming.json'),
      inspectionListPath: path.join(EXAMPLES_DIR, 'inspection.csv'),
      outputBasePath: outputDir,
      createOutputDir: true,
    });

    const pointsContent = await fs.readFile(path.join(EXAMPLES_DIR, 'points.json'), 'utf-8');
    const pointsData = JSON.parse(pointsContent);
    const namingContent = await fs.readFile(path.join(EXAMPLES_DIR, 'naming.json'), 'utf-8');
    const namingRule = JSON.parse(namingContent);

    await initProfile(outputDir, 'profile1', {
      points: pointsData.points,
      namingRule,
      timeWindowMinutes: 60,
    });

    await initProfile(outputDir, 'profile2', {
      points: pointsData.points,
      namingRule,
      timeWindowMinutes: 30,
    });
    console.log(`   Created two profiles: profile1 and profile2`);

    await switchProfile(outputDir, 'profile1');
    console.log(`   Switched to profile1`);

    const batchDir = path.join(outputDir, 'batches');
    await fs.ensureDir(batchDir);
    const fakeBatchDir = path.join(batchDir, 'fake-running-batch');
    await fs.ensureDir(fakeBatchDir);
    await fs.writeJson(path.join(fakeBatchDir, 'status.json'), {
      batchId: 'fake-running-batch',
      status: 'running',
      lock: { locked: true, lockedAt: new Date().toISOString(), lockedBy: 'archive' },
      createdAt: new Date().toISOString(),
      totalPhotos: 0,
      successCount: 0,
      failedCount: 0,
      errors: [],
      actions: [],
    });
    console.log(`   Created a fake running batch`);

    const result = await switchProfile(outputDir, 'profile2');

    if (result.success) {
      console.log('❌ FAILED: profile switch succeeded when there is a running batch');
      return false;
    }

    if (!result.message.includes('running')) {
      console.log(`❌ FAILED: error message does not mention running batch: ${result.message}`);
      return false;
    }

    const currentProfile = await fs.readFile(path.join(outputDir, 'config', '.current_profile'), 'utf-8').catch(() => null);
    if (currentProfile && currentProfile.trim() === 'profile2') {
      console.log('❌ FAILED: profile was switched despite running batch');
      return false;
    }

    console.log('✅ PASSED: profile switch correctly rejected due to running batch');
    console.log(`   Error message: ${result.message}`);
    return true;
    
  } finally {
    await cleanup();
  }
}

async function testDiffNormalComparison() {
  console.log('\n=== Test 10: diff should compare two completed batches correctly ===');
  
  const { inputDir, outputDir } = await setup();
  
  try {
    const config = await loadConfig({
      pointConfigPath: path.join(EXAMPLES_DIR, 'points.json'),
      namingRulePath: path.join(EXAMPLES_DIR, 'naming.json'),
      inspectionListPath: path.join(EXAMPLES_DIR, 'inspection.csv'),
      outputBasePath: outputDir,
      createOutputDir: true,
    });

    const status1 = await executeArchive(inputDir, config);
    console.log(`   Created batch 1: ${status1.batchId}`);

    await fs.remove(path.join(outputDir, 'archive'));
    await fs.writeFile(path.join(inputDir, '2栋-2层-消防栓-1-20240101-100000.jpg'), 'test-photo-5-new-content-longer');

    const status2 = await executeArchive(inputDir, config);
    console.log(`   Created batch 2: ${status2.batchId}`);

    const result = await compareBatches(outputDir, status1.batchId, status2.batchId);

    if (!result.success) {
      console.log(`❌ FAILED: diff comparison failed: ${result.message}`);
      return false;
    }

    if (!result.result) {
      console.log('❌ FAILED: no diff result returned');
      return false;
    }

    const diff = result.result;
    console.log(`   Summary: added=${diff.summary.totalAdded}, removed=${diff.summary.totalRemoved}, changed=${diff.summary.totalChanged}`);

    if (diff.summary.totalChanged === 0) {
      console.log('❌ FAILED: expected some changes between batches');
      return false;
    }

    const diffPath = path.join(outputDir, 'batches', status2.batchId, 'diffs');
    const diffFiles = await fs.readdir(diffPath).catch(() => []);
    if (diffFiles.length === 0) {
      console.log('❌ FAILED: diff result was not saved to batch directory');
      return false;
    }

    console.log('✅ PASSED: diff correctly compared two batches');
    console.log(`   Changed: ${diff.summary.totalChanged}`);
    return true;
    
  } finally {
    await cleanup();
  }
}

async function testDiffWithRolledBackBatch() {
  console.log('\n=== Test 11: diff should fail when batch is rolled back ===');
  
  const { inputDir, outputDir } = await setup();
  
  try {
    const config = await loadConfig({
      pointConfigPath: path.join(EXAMPLES_DIR, 'points.json'),
      namingRulePath: path.join(EXAMPLES_DIR, 'naming.json'),
      inspectionListPath: path.join(EXAMPLES_DIR, 'inspection.csv'),
      outputBasePath: outputDir,
      createOutputDir: true,
    });

    const status1 = await executeArchive(inputDir, config);
    console.log(`   Created batch 1: ${status1.batchId}`);

    await fs.remove(path.join(outputDir, 'archive'));
    const status2 = await executeArchive(inputDir, config);
    console.log(`   Created batch 2: ${status2.batchId}`);

    await rollbackBatch(status1.batchId, outputDir);
    console.log(`   Rolled back batch 1`);

    const result = await compareBatches(outputDir, status1.batchId, status2.batchId);

    if (result.success) {
      console.log('❌ FAILED: diff succeeded when one batch is rolled back');
      return false;
    }

    if (!result.message.includes('rolled back')) {
      console.log(`❌ FAILED: error message does not mention rolled back: ${result.message}`);
      return false;
    }

    console.log('✅ PASSED: diff correctly rejected rolled back batch');
    console.log(`   Error message: ${result.message}`);
    return true;
    
  } finally {
    await cleanup();
  }
}

async function testScanCleanWorkspace() {
  console.log('\n=== Test 12: scan should pass on clean workspace ===');
  
  const { inputDir, outputDir } = await setup();
  
  try {
    const config = await loadConfig({
      pointConfigPath: path.join(EXAMPLES_DIR, 'points.json'),
      namingRulePath: path.join(EXAMPLES_DIR, 'naming.json'),
      inspectionListPath: path.join(EXAMPLES_DIR, 'inspection.csv'),
      outputBasePath: outputDir,
      createOutputDir: true,
    });

    await executeArchive(inputDir, config);
    console.log('   Created a clean archive');

    const result = await scanWorkspace(outputDir);

    if (result.failed !== 0) {
      console.log(`❌ FAILED: expected 0 failed batches, got ${result.failed}`);
      return false;
    }

    if (result.skipped !== 0) {
      console.log(`❌ FAILED: expected 0 skipped batches, got ${result.skipped}`);
      return false;
    }

    if (result.orphanFiles.length !== 0) {
      console.log(`❌ FAILED: expected 0 orphan files, got ${result.orphanFiles.length}`);
      return false;
    }

    const hasError = result.issues.some(i => i.level === 'error');
    if (hasError) {
      console.log(`❌ FAILED: found errors in clean workspace`);
      return false;
    }

    console.log('✅ PASSED: scan correctly passed on clean workspace');
    console.log(`   Stats: scanned=${result.scanned}, passed=${result.passed}, failed=${result.failed}`);
    return true;
    
  } finally {
    await cleanup();
  }
}

async function testScanOrphanFiles() {
  console.log('\n=== Test 13: scan should detect orphan files ===');
  
  const { inputDir, outputDir } = await setup();
  
  try {
    const config = await loadConfig({
      pointConfigPath: path.join(EXAMPLES_DIR, 'points.json'),
      namingRulePath: path.join(EXAMPLES_DIR, 'naming.json'),
      inspectionListPath: path.join(EXAMPLES_DIR, 'inspection.csv'),
      outputBasePath: outputDir,
      createOutputDir: true,
    });

    await executeArchive(inputDir, config);
    console.log('   Created archive');

    const orphanDir = path.join(outputDir, 'archive', '1栋', '1层-消防栓');
    const orphanFile = path.join(orphanDir, 'orphan_photo.jpg');
    await fs.writeFile(orphanFile, 'this is an orphan file not referenced by any batch');
    console.log('   Created orphan file');

    const result = await scanWorkspace(outputDir);

    if (result.orphanFiles.length !== 1) {
      console.log(`❌ FAILED: expected 1 orphan file, got ${result.orphanFiles.length}`);
      return false;
    }

    const hasWarning = result.issues.some(i => i.level === 'warning' && i.message.includes('孤儿'));
    if (!hasWarning) {
      console.log('❌ FAILED: no warning issued for orphan files');
      return false;
    }

    console.log('✅ PASSED: scan correctly detected orphan files');
    console.log(`   Found ${result.orphanFiles.length} orphan file(s)`);
    return true;
    
  } finally {
    await cleanup();
  }
}

async function testScanCountMismatch() {
  console.log('\n=== Test 14: scan should detect count mismatch ===');
  
  const { inputDir, outputDir } = await setup();
  
  try {
    const config = await loadConfig({
      pointConfigPath: path.join(EXAMPLES_DIR, 'points.json'),
      namingRulePath: path.join(EXAMPLES_DIR, 'naming.json'),
      inspectionListPath: path.join(EXAMPLES_DIR, 'inspection.csv'),
      outputBasePath: outputDir,
      createOutputDir: true,
    });

    const status = await executeArchive(inputDir, config);
    console.log(`   Created batch: ${status.batchId}`);

    const archiveDir = path.join(outputDir, 'archive', '1栋', '1层-消防栓');
    const files = await fs.readdir(archiveDir);
    const firstFile = files.find(f => f.endsWith('.jpg'));
    if (firstFile) {
      await fs.remove(path.join(archiveDir, firstFile));
      console.log(`   Removed one archived file`);
    }

    const result = await scanWorkspace(outputDir);

    if (result.failed !== 1) {
      console.log(`❌ FAILED: expected 1 failed batch, got ${result.failed}`);
      return false;
    }

    const hasError = result.issues.some(i => i.level === 'error' && i.message.includes('数量不匹配'));
    if (!hasError) {
      console.log('❌ FAILED: no error issued for count mismatch');
      return false;
    }

    console.log('✅ PASSED: scan correctly detected count mismatch');
    return true;
    
  } finally {
    await cleanup();
  }
}

async function testScanSkipsLockedBatch() {
  console.log('\n=== Test 15: scan should skip locked/running batches ===');
  
  const { inputDir, outputDir } = await setup();
  
  try {
    const config = await loadConfig({
      pointConfigPath: path.join(EXAMPLES_DIR, 'points.json'),
      namingRulePath: path.join(EXAMPLES_DIR, 'naming.json'),
      inspectionListPath: path.join(EXAMPLES_DIR, 'inspection.csv'),
      outputBasePath: outputDir,
      createOutputDir: true,
    });

    const status = await executeArchive(inputDir, config);
    console.log(`   Created batch: ${status.batchId}`);

    const batchDir = path.join(outputDir, 'batches', status.batchId);
    const statusPath = path.join(batchDir, 'status.json');
    const currentStatus = await fs.readJson(statusPath);
    currentStatus.status = 'running';
    currentStatus.lock = { locked: true, lockedAt: new Date().toISOString(), lockedBy: 'test' };
    await fs.writeJson(statusPath, currentStatus);
    console.log('   Set batch as running/locked');

    const result = await scanWorkspace(outputDir);

    if (result.skipped !== 1) {
      console.log(`❌ FAILED: expected 1 skipped batch, got ${result.skipped}`);
      return false;
    }

    if (result.scanned !== 0) {
      console.log(`❌ FAILED: expected 0 scanned batches, got ${result.scanned}`);
      return false;
    }

    const hasInfo = result.issues.some(i => i.level === 'info' && i.message.includes('跳过锁定'));
    if (!hasInfo) {
      console.log('❌ FAILED: no info message about skipped batch');
      return false;
    }

    console.log('✅ PASSED: scan correctly skipped locked batch');
    console.log(`   Stats: scanned=${result.scanned}, skipped=${result.skipped}`);
    return true;
    
  } finally {
    await cleanup();
  }
}

async function testReportCleanData() {
  console.log('\n=== Test 16: report should work with clean data ===');
  
  const { inputDir, outputDir } = await setup();
  
  try {
    const config = await loadConfig({
      pointConfigPath: path.join(EXAMPLES_DIR, 'points.json'),
      namingRulePath: path.join(EXAMPLES_DIR, 'naming.json'),
      inspectionListPath: path.join(EXAMPLES_DIR, 'inspection.csv'),
      outputBasePath: outputDir,
      createOutputDir: true,
    });

    await executeArchive(inputDir, config);
    console.log('   Created archive');

    const result = await generateReport(outputDir, {});

    if (result.summary.warnings.length > 0) {
      console.log(`❌ FAILED: unexpected warnings: ${result.summary.warnings.join(', ')}`);
      return false;
    }

    if (result.summary.totalBatches !== 1) {
      console.log(`❌ FAILED: expected 1 batch, got ${result.summary.totalBatches}`);
      return false;
    }

    if (result.summary.totalPhotos !== 4) {
      console.log(`❌ FAILED: expected 4 photos, got ${result.summary.totalPhotos}`);
      return false;
    }

    if (result.summary.buildingCoverage.length === 0) {
      console.log('❌ FAILED: no building coverage data');
      return false;
    }

    console.log('✅ PASSED: report correctly generated with clean data');
    console.log(`   Total batches: ${result.summary.totalBatches}`);
    console.log(`   Total photos: ${result.summary.totalPhotos}`);
    return true;
    
  } finally {
    await cleanup();
  }
}

async function testReportWithCorruptedLog() {
  console.log('\n=== Test 17: report should handle corrupted log lines ===');
  
  const { inputDir, outputDir } = await setup();
  
  try {
    const config = await loadConfig({
      pointConfigPath: path.join(EXAMPLES_DIR, 'points.json'),
      namingRulePath: path.join(EXAMPLES_DIR, 'naming.json'),
      inspectionListPath: path.join(EXAMPLES_DIR, 'inspection.csv'),
      outputBasePath: outputDir,
      createOutputDir: true,
    });

    await executeArchive(inputDir, config);
    console.log('   Created archive');

    const logPath = path.join(outputDir, 'ops.log.jsonl');
    await fs.appendFile(logPath, '\nthis is not valid json\n');
    await fs.appendFile(logPath, '\n{"incomplete": true\n');
    console.log('   Added corrupted log lines');

    const result = await generateReport(outputDir, {});

    if (result.summary.warnings.length < 2) {
      console.log(`❌ FAILED: expected at least 2 warnings, got ${result.summary.warnings.length}`);
      return false;
    }

    const hasCorruptionWarning = result.summary.warnings.some(w => 
      w.includes('解析失败') || w.includes('格式不正确')
    );
    if (!hasCorruptionWarning) {
      console.log('❌ FAILED: no warning about corrupted logs');
      return false;
    }

    if (result.summary.totalBatches !== 1) {
      console.log(`❌ FAILED: expected 1 batch, got ${result.summary.totalBatches}`);
      return false;
    }

    console.log('✅ PASSED: report correctly handled corrupted log lines');
    console.log(`   Warnings: ${result.summary.warnings.length}`);
    return true;
    
  } finally {
    await cleanup();
  }
}

async function testReportWithMissingStatusJson() {
  console.log('\n=== Test 18: report should handle missing status.json ===');
  
  const { inputDir, outputDir } = await setup();
  
  try {
    const config = await loadConfig({
      pointConfigPath: path.join(EXAMPLES_DIR, 'points.json'),
      namingRulePath: path.join(EXAMPLES_DIR, 'naming.json'),
      inspectionListPath: path.join(EXAMPLES_DIR, 'inspection.csv'),
      outputBasePath: outputDir,
      createOutputDir: true,
    });

    await executeArchive(inputDir, config);
    console.log('   Created archive');

    const batchDir = path.join(outputDir, 'batches');
    const batchIds = await fs.readdir(batchDir);
    const statusPath = path.join(batchDir, batchIds[0], 'status.json');
    await fs.remove(statusPath);
    console.log('   Removed status.json');

    const result = await generateReport(outputDir, {});

    const hasMissingWarning = result.summary.warnings.some(w => 
      w.includes('缺少 status.json')
    );
    if (!hasMissingWarning) {
      console.log('❌ FAILED: no warning about missing status.json');
      return false;
    }

    if (result.summary.totalBatches !== 0) {
      console.log(`❌ FAILED: expected 0 batches, got ${result.summary.totalBatches}`);
      return false;
    }

    console.log('✅ PASSED: report correctly handled missing status.json');
    console.log(`   Warnings: ${result.summary.warnings.join(', ')}`);
    return true;
    
  } finally {
    await cleanup();
  }
}

async function testReportSkipsLockedBatch() {
  console.log('\n=== Test 19: report should skip locked batches ===');
  
  const { inputDir, outputDir } = await setup();
  
  try {
    const config = await loadConfig({
      pointConfigPath: path.join(EXAMPLES_DIR, 'points.json'),
      namingRulePath: path.join(EXAMPLES_DIR, 'naming.json'),
      inspectionListPath: path.join(EXAMPLES_DIR, 'inspection.csv'),
      outputBasePath: outputDir,
      createOutputDir: true,
    });

    await executeArchive(inputDir, config);
    console.log('   Created archive');

    const batchDir = path.join(outputDir, 'batches');
    const batchIds = await fs.readdir(batchDir);
    const statusPath = path.join(batchDir, batchIds[0], 'status.json');
    const status = await fs.readJson(statusPath);
    status.lock = { locked: true, lockedAt: new Date().toISOString(), lockedBy: 'test' };
    await fs.writeJson(statusPath, status);
    console.log('   Locked batch');

    const result = await generateReport(outputDir, {});

    if (result.summary.skippedLockedBatches.length !== 1) {
      console.log(`❌ FAILED: expected 1 skipped locked batch, got ${result.summary.skippedLockedBatches.length}`);
      return false;
    }

    if (result.summary.totalBatches !== 0) {
      console.log(`❌ FAILED: expected 0 batches in stats, got ${result.summary.totalBatches}`);
      return false;
    }

    console.log('✅ PASSED: report correctly skipped locked batch');
    console.log(`   Skipped: ${result.summary.skippedLockedBatches.join(', ')}`);
    return true;
    
  } finally {
    await cleanup();
  }
}

async function testReportEmptyTimeRange() {
  console.log('\n=== Test 20: report should handle empty time range ===');
  
  const { inputDir, outputDir } = await setup();
  
  try {
    const config = await loadConfig({
      pointConfigPath: path.join(EXAMPLES_DIR, 'points.json'),
      namingRulePath: path.join(EXAMPLES_DIR, 'naming.json'),
      inspectionListPath: path.join(EXAMPLES_DIR, 'inspection.csv'),
      outputBasePath: outputDir,
      createOutputDir: true,
    });

    await executeArchive(inputDir, config);
    console.log('   Created archive');

    const result = await generateReport(outputDir, {
      from: '2099-01-01',
      to: '2099-12-31',
    });

    if (result.summary.totalBatches !== 0) {
      console.log(`❌ FAILED: expected 0 batches, got ${result.summary.totalBatches}`);
      return false;
    }

    if (result.summary.totalOperations !== 0) {
      console.log(`❌ FAILED: expected 0 operations, got ${result.summary.totalOperations}`);
      return false;
    }

    if (result.summary.dailyStats.length !== 0) {
      console.log(`❌ FAILED: expected 0 daily stats, got ${result.summary.dailyStats.length}`);
      return false;
    }

    console.log('✅ PASSED: report correctly handled empty time range');
    return true;
    
  } finally {
    await cleanup();
  }
}

async function runTests() {
  console.log('========================================');
  console.log('   Regression Tests for CLI Safety');
  console.log('========================================');
  
  let passed = 0;
  let failed = 0;
  
  try {
    if (await testDryRunNoDirectoryCreation()) passed++; else failed++;
    if (await testRollbackWithUnrelatedFiles()) passed++; else failed++;
    if (await testRollbackWithFileMismatch()) passed++; else failed++;
    if (await testSuccessfulRollbackAfterCleanup()) passed++; else failed++;
    if (await testPurgeKeepsRecentBatches()) passed++; else failed++;
    if (await testRollbackWithLockConflict()) passed++; else failed++;
    if (await testIntegrityCheckFail()) passed++; else failed++;
    if (await testPurgeSkipsRunningBatches()) passed++; else failed++;
    if (await testProfileSwitchWithRunningBatch()) passed++; else failed++;
    if (await testDiffNormalComparison()) passed++; else failed++;
    if (await testDiffWithRolledBackBatch()) passed++; else failed++;
    if (await testScanCleanWorkspace()) passed++; else failed++;
    if (await testScanOrphanFiles()) passed++; else failed++;
    if (await testScanCountMismatch()) passed++; else failed++;
    if (await testScanSkipsLockedBatch()) passed++; else failed++;
    if (await testReportCleanData()) passed++; else failed++;
    if (await testReportWithCorruptedLog()) passed++; else failed++;
    if (await testReportWithMissingStatusJson()) passed++; else failed++;
    if (await testReportSkipsLockedBatch()) passed++; else failed++;
    if (await testReportEmptyTimeRange()) passed++; else failed++;
  } catch (error) {
    console.error('\n❌ Test execution error:', error.message);
    failed++;
  }
  
  console.log('\n========================================');
  console.log(`   Results: ${passed} passed, ${failed} failed`);
  console.log('========================================');
  
  process.exit(failed > 0 ? 1 : 0);
}

runTests();
