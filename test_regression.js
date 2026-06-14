#!/usr/bin/env node

const fs = require('fs-extra');
const path = require('path');

const { loadConfig } = require('./dist/config/loader');
const { performDryRun } = require('./dist/core/dryRun');
const { executeArchive, loadBatchStatus } = require('./dist/core/archive');
const { rollbackBatch } = require('./dist/core/rollback');

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
