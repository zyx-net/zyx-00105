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
