# 物业巡检照片归档 CLI 工具

一个用于物业巡检照片归档管理的命令行工具，支持按楼栋、点位和轮次归档，追踪退回补拍，支持批次回滚和导出。

## 功能特性

- **Dry-run 检测**: 执行归档前进行完整检查，包括缺拍、重复、清单外照片、时间超窗、目录冲突
- **智能归档**: 按楼栋/点位/轮次自动组织照片
- **批次管理**: 记录每次归档的详细动作和状态
- **回滚支持**: 支持按批次回滚，保护数据安全
- **补拍合并**: 退回后可合并补拍版本
- **导出功能**: 支持导出 JSON/CSV 格式记录
- **持久化状态**: 重启后历史记录、补拍备注、回滚结果均可追溯
- **Profile 管理**: 支持多楼盘配置切换，包含点位、命名规则、时间窗口的完整配置集合
- **批次对比**: 对比两个批次的差异，检测新增、删除、变更的照片

## 安装

```bash
npm install
npm run build
npm link
```

## 命令列表

### 1. Dry-run 检测

在执行归档前进行完整检查，不实际执行归档操作。

```bash
pi-archiver dry-run \
  -i /path/to/photos \
  -p ./examples/points.json \
  -n ./examples/naming.json \
  -l ./examples/inspection.csv \
  -o /path/to/output \
  -w 60
```

### 2. 执行归档

执行实际归档操作，会先进行 dry-run 检测，确认后执行。

```bash
pi-archiver archive \
  -i /path/to/photos \
  -p ./examples/points.json \
  -n ./examples/naming.json \
  -l ./examples/inspection.csv \
  -o /path/to/output \
  -f directory
```

### 3. 查看批次状态

查看所有批次或指定批次的状态。

```bash
# 查看所有批次
pi-archiver status -o /path/to/output

# 查看指定批次
pi-archiver status -o /path/to/output -b <batch-id>
```

### 4. 回滚批次

回滚已完成的批次，删除归档文件。

```bash
pi-archiver rollback -o /path/to/output -b <batch-id>
```

### 5. 合并补拍批次

将补拍批次合并到目标批次。

```bash
pi-archiver merge \
  -o /path/to/output \
  -s <source-batch-id> \
  -t <target-batch-id>
```

### 6. 导出记录

导出批次记录为 JSON 或 CSV 格式。

```bash
# 导出所有批次
pi-archiver export -o /path/to/export -b /path/to/archive -f json

# 导出指定批次
pi-archiver export -o /path/to/export -b /path/to/archive -f csv -i <batch-id>
```

### 7. Profile 管理

Profile 用于管理不同项目/楼盘的配置集合，支持快速切换点位配置、命名规则和时间窗口设置。

#### 7.1 创建 Profile

```bash
# 创建新的配置 profile
pi-archiver profile init \
  -o /path/to/output \
  -n 楼盘A \
  -p ./examples/points.json \
  -r ./examples/naming.json \
  -w 60
```

**参数说明:**
- `-o, --output`: 输出基础目录，profile 将保存在 `{output}/config/profiles/` 下
- `-n, --name`: Profile 名称（唯一标识）
- `-p, --points`: 点位配置文件路径
- `-r, --naming`: 命名规则文件路径
- `-w, --window`: 时间窗口（分钟），默认 60
- `--dry-run`: 预览模式，不实际创建

#### 7.2 列出所有 Profile

```bash
# 列出所有配置 profile
pi-archiver profile list -o /path/to/output
```

输出示例:
```
=== 配置 Profile 列表 (共 2 个) ===

名称: 楼盘A [当前激活]
创建时间: 2024-01-15 10:30:00
点位数: 5
---
名称: 楼盘B
创建时间: 2024-01-16 14:20:00
点位数: 8
---
```

#### 7.3 切换 Profile

```bash
# 切换到指定 profile
pi-archiver profile switch -o /path/to/output -n 楼盘B
```

> **注意**: 如果存在运行中的批次，切换操作将被拒绝，需等待批次完成或回滚后再切换。

#### 7.4 显示当前 Profile

```bash
# 显示当前激活的 profile 详细信息
pi-archiver profile show -o /path/to/output

# 以 JSON 格式输出（方便脚本调用）
pi-archiver profile show -o /path/to/output --json
```

输出示例:
```
=== 当前激活的 Profile ===
名称: 楼盘A
存储位置: /path/to/output/config/profiles/楼盘A.json
命名规则: {building}-{floor}-{position}-{round}-{date}
日期格式: yyyyMMdd-HHmmss
时间窗口: 60 分钟
点位数: 5
创建时间: 2024-01-15 10:30:00
```

JSON 输出示例:
```json
{
  "name": "楼盘A",
  "storagePath": "/path/to/output/config/profiles/楼盘A.json",
  "namingPattern": "{building}-{floor}-{position}-{round}-{date}",
  "dateFormat": "yyyyMMdd-HHmmss",
  "timeWindowMinutes": 60,
  "pointsCount": 5,
  "createdAt": "2024-01-15T10:30:00.000Z"
}
```

#### 7.5 删除 Profile

```bash
# 删除指定 profile（不能删除当前激活的 profile）
pi-archiver profile delete -o /path/to/output -n 楼盘B
```

> **注意**: 不能删除当前激活的 profile，需先切换到其他 profile。

### 8. 批次差异对比

对比两个已完成批次之间的照片差异，支持新增、删除、变更检测。

```bash
# 对比两个批次
pi-archiver diff \
  -o /path/to/output \
  -b1 7c31350f-e2eb-4d22-a4e3-2127406ca773 \
  -b2 1ad7f59c-33cd-4c72-beb5-4d768bed3510

# 对比并导出为 JSON
pi-archiver diff \
  -o /path/to/output \
  -b1 <batch-id-1> \
  -b2 <batch-id-2> \
  -f json \
  -e /path/to/diff_result.json

# 对比并导出为 CSV
pi-archiver diff \
  -o /path/to/output \
  -b1 <batch-id-1> \
  -b2 <batch-id-2> \
  -f csv \
  -e /path/to/diff_result.csv
```

**参数说明:**
- `-o, --output`: 输出基础目录
- `-b1, --batch1`: 第一个批次ID（基准批次）
- `-b2, --batch2`: 第二个批次ID（对比批次）
- `-f, --format`: 导出格式，`json` 或 `csv`，默认 `json`
- `-e, --export`: 导出文件路径
- `--dry-run`: 预览模式，不保存结果

**输出示例:**
```
=== Batch Comparison Report ===
Batch 1: 7c31350f-e2eb-4d22-a4e3-2127406ca773
Batch 2: 1ad7f59c-33cd-4c72-beb5-4d768bed3510
Compared at: 2024-01-15 15:30:00

--- Summary ---
Added: 1
Removed: 0
Changed: 2
Unchanged: 3

--- Added Photos ---
  [P006] 3栋-1层-消防栓-1-20240115-140000.jpg (204800 bytes)

--- Changed Photos ---
  [P001] 1栋-1层-消防栓-1-20240115-143000.jpg
    Size: 153600 -> 184320 (+30720 bytes)
    Time: +2h30m0s
```

**错误情况:**
- 对比已回滚批次：`Batch <batch-id> has been rolled back`
- 对比运行中批次：`Batch <batch-id> is still running`

### 9. 归档完整性校验

校验 archive 目录下的照片文件与 batches 中 status.json 记录的引用是否一致。

```bash
# 执行完整性校验
pi-archiver validate -o /path/to/output

# 按楼栋过滤校验
pi-archiver validate -o /path/to/output --building 1栋

# JSON 格式输出
pi-archiver validate -o /path/to/output --json

# 自动清理孤立文件（清理前会备份到 .backup/validation_fix/<timestamp>/）
pi-archiver validate -o /path/to/output --fix

# 组合使用
pi-archiver validate -o /path/to/output --building 1栋 --fix --json
```

**参数说明:**
- `-o, --output`: 输出基础目录
- `--building`: 按楼栋名称过滤
- `--json`: 以 JSON 格式输出结果
- `--fix`: 自动清理孤立文件，清理前会备份

**检测的问题类型:**
- **引用文件缺失**: batches 中记录的文件在 archive 目录中不存在
- **孤立文件**: archive 目录中存在但未被任何批次引用的文件
- **重复引用**: 同一文件被多个批次引用

**输出示例:**
```
=== 归档完整性校验报告 ===

扫描批次数: 5
扫描文件数: 40

❌ 发现不一致:

--- 引用文件缺失 (2) ---
  - /path/to/output/archive/1栋/1层-消防栓/missing.jpg
    引用文件缺失

--- 孤立文件 (3) ---
  - /path/to/output/archive/1栋/1层-电梯厅/orphan1.jpg
  - /path/to/output/archive/2栋/2层-消防栓/orphan2.jpg

--- 重复引用 (1) ---
  - /path/to/output/archive/1栋/1层-消防栓/duplicate.jpg
    同一文件被多个批次引用: batch1, batch2

✅ 校验通过 - 归档数据完整一致
```

**JSON 输出示例:**
```json
{
  "valid": false,
  "issues": [
    {
      "type": "missing_file",
      "path": "/path/to/output/archive/1栋/1层-消防栓/missing.jpg",
      "description": "引用文件缺失",
      "batchIds": ["abc123"]
    },
    {
      "type": "orphan_file",
      "path": "/path/to/output/archive/1栋/1层-电梯厅/orphan.jpg",
      "description": "孤立文件未被任何批次引用",
      "batchIds": []
    },
    {
      "type": "duplicate_reference",
      "path": "/path/to/output/archive/1栋/1层-消防栓/duplicate.jpg",
      "description": "同一文件被多个批次引用: batch1, batch2",
      "batchIds": ["batch1", "batch2"]
    }
  ],
  "skippedLockedBatches": ["locked_batch_id"],
  "totalBatches": 5,
  "totalFiles": 40,
  "fixedCount": 0
}
```

**注意:**
- Locked 批次会被跳过不校验
- `--fix` 仅清理孤立文件，不处理缺失引用和重复引用
- 清理前会自动备份到 `.backup/validation_fix/<timestamp>/`

### 10. 统计报告

生成归档操作的统计报告，汇总操作次数、照片数、楼栋覆盖情况等。

```bash
# 生成完整报告
pi-archiver report -o /path/to/output

# 指定时间范围
pi-archiver report -o /path/to/output --from 2024-01-01 --to 2024-12-31

# 按楼栋过滤
pi-archiver report -o /path/to/output --building 1栋

# JSON 格式输出
pi-archiver report -o /path/to/output --json

# 显示详细日志
pi-archiver report -o /path/to/output --detail

# 不将统计摘要写回日志
pi-archiver report -o /path/to/output --no-save
```

**参数说明:**
- `-o, --output`: 输出基础目录
- `--from`: 起始日期 (YYYY-MM-DD)
- `--to`: 结束日期 (YYYY-MM-DD)
- `--building`: 按楼栋过滤
- `--json`: 以 JSON 格式输出
- `--detail`: 显示详细日志
- `--no-save`: 不将统计摘要写回日志

**输出示例:**
```
╔════════════════════════════════════════════════════════════════════════╗
║                        巡检照片归档统计报告                            ║
╚════════════════════════════════════════════════════════════════════════╝

📅 时间范围: 2024-01-01 ~ 2024-12-31
📊 统计天数: 30 天

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                          操作统计                                      
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
总操作次数: 150
操作类型分布:
  archive        : 45 次
  status         : 60 次
  rollback       : 5 次

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                          批次统计                                      
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
总批次数: 45
总照片数: 1800
平均批次规模: 40.00 张/批
成功率: 98.50%

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                          楼栋覆盖                                      
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🏢 1栋
  1层   : 5 个点位
  2层   : 5 个点位

🏢 2栋
  1层   : 5 个点位

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                          每日统计                                      
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
┌─────────────┬────────────┬────────────┬────────────┬─────────────┐
│    日期     │ 批次数     │ 照片数     │ 成功数     │ 平均规模    │
├─────────────┼────────────┼────────────┼────────────┼─────────────┤
│ 2024-01-15  │ 2          │ 80         │ 78         │ 40.00       │
│ 2024-01-16  │ 1          │ 40         │ 40         │ 40.00       │
└─────────────┴────────────┴────────────┴────────────┴─────────────┘
```

**数据完整性预检:**
- 日志行损坏：标记 warning 跳过
- status.json 缺失：标记 warning 跳过
- locked batch：标记 skipped 不统计

**JSON 输出示例:**
```json
{
  "startDate": "2024-01-01",
  "endDate": "2024-12-31",
  "totalDays": 30,
  "totalOperations": 150,
  "operationBreakdown": {
    "archive": 45,
    "status": 60,
    "rollback": 5
  },
  "totalPhotos": 1800,
  "successRate": 98.5,
  "totalBatches": 45,
  "avgBatchSize": 40,
  "buildingCoverage": [...],
  "dailyStats": [...],
  "warnings": [],
  "skippedLockedBatches": []
}
```

## 配置文件说明

### 点位配置 (points.json)

```json
{
  "points": [
    {
      "id": "P001",
      "name": "消防栓-1栋1层",
      "building": "1栋",
      "floor": "1层",
      "position": "消防栓",
      "required": true,
      "description": "1栋1层走廊消防栓"
    }
  ]
}
```

### 命名规则 (naming.json)

```json
{
  "pattern": "{building}-{floor}-{position}-{round}-{date}",
  "dateFormat": "yyyyMMdd-HHmmss",
  "allowedExtensions": [".jpg", ".jpeg", ".png", ".gif"],
  "maxFileNameLength": 100
}
```

### 巡检清单 (inspection.csv)

```csv
id,pointId,batchId,round,scheduledTime,status,rejectReason,retryCount
I001,P001,BATCH-20240101-001,1,2024-01-01T08:00:00Z,pending,,0
```

## 目录结构

```
output/
├── archive/           # 归档目录
│   ├── 1栋/
│   │   └── 1层-消防栓/
│   │       └── 1栋-1层-消防栓-1-20240101-080000.jpg
│   └── 2栋/
├── batches/           # 批次记录
│   └── <batch-id>/
│       └── status.json
└── .backup/           # 备份目录
    └── <batch-id>/
```

## 错误处理

工具会在以下情况停止执行并给出清晰错误：
- 缺少必拍点位
- 同批次重复执行
- 回滚路径被无关文件占用
- 输出目录冲突

## 许可证

MIT
