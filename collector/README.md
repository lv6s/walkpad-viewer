# Walkpad 数据采集工作台

电脑直连蓝牙采集鞋垫与 IMU，浏览器里实时看波形、零偏与速度，录完导出 parquet。数据只落本机 `records/`，不上传。

## 快速开始

Windows 双击 `open_workbench.cmd`；其它平台：

```bash
pip install -r requirements-workbench.txt
python launch_workbench.py          # 起后台并在浏览器打开，端口从 8875 起找空闲的
python launch_workbench.py --stop   # 关闭后台
python launch_workbench.py --legacy # 旧版维特多设备页面
```

后台是 FastAPI，只监听 `127.0.0.1`，控制接口要带启动时生成的一次性 token（页面自动带上）。浏览器全部断开后后台会自行退出，可用 `--idle-exit` 调整宽限。

## 支持的设备

| 设备 | 识别方式 | 协议 | 压力 | 零偏补偿 |
| --- | --- | --- | --- | --- |
| 自研鞋垫（D56） | 广播 0x1111，产品类型 1 | 同下，`46+2n` 字节帧，56 点压力 | 有 | 有 |
| 自研独立 IMU | 广播 0x1111，产品类型 3 | 与鞋垫同一套（去压力通道） | 无 | 有 |
| 维特 WT901 / JY901 | 名称前缀 `WT` | `0x55 0x61` 帧 | 无 | 无，用原始值 |

扫描优先解析广播里的厂商数据（公司号 `0x1111`：布局版本、产品类型、左右脚、配对号），广播未登记时才回退到名称前缀。自研两类设备共用 GATT（notify `2a37` / write `ffe1`）与六轴换算 `(raw_y, -raw_x, raw_z)`，加速度 0.488 mg/LSB、陀螺 0.07 dps/LSB。

## 零偏

按设备记账，鞋垫与独立 IMU 都走同一条链路（静止检测 → 陀螺零偏估计 → 逐帧扣除），四种操作：自动跟踪、手动锁定、静止校准、重置。维特设备不参与。速度估计在自研设备上引用这份零偏做误差状态约束。

## 采集与导出

- 落盘：`records/<session>/frames.parquet`，`schema_version=capture_frames.v2`，含原始帧十六进制、六轴原值与物理量、设备日历、`bias_used`、`device_kind`。
- 导出：列名与 app 的 `standard_measurement_frames` 同构，末尾多 5 个自定义列（`placement_code`、`gyro_temperature_celsius`、`device_date`、`device_time`、`dropped_frames_before`），在 parquet 的 kvMetadata 里登记。
- 独立 IMU 导出 `pressure_status='absent'`、压力数组留空，不写 70 个 0 冒充实测零压。
- CSV 转 parquet：`python csv2parquet.py <in.csv> [out.parquet]`。

## 目录

```
backend/      FastAPI 服务：蓝牙采集、协议解码、零偏、速度、导出
frontend/     Vue 工作台页面（dist/ 是预构建产物）
activity/     活动识别：ONNX 权重、预处理、对拍脚本
js/ css/      旧版维特多设备页面（wt901ble_live.html）
test/         Node 端到端脚本（部分需要 Chrome 调试端口）
tests_v2/     pytest：后端接口与速度估计
```

## 测试

```bash
pytest tests_v2
node test/check_bias.cjs        # 零偏 worker
node test/check_press.js        # 导出列与协议解析
```

需要浏览器的脚本依赖 Chrome 远程调试端口，未启动浏览器时会卡住等待。

## 已知限制

- 独立 IMU 没有压力通道，不参与压力相关的步态推断；活动识别只出 IMU 侧结果。
- 手机 App 链路（`backend/phone.py`）按协议名定设备类型，尚未识别广播里的产品类型 3。
- 设备端 IMU 标定命令（0x18 标定 / 0x19 清除 / 0x0d 查状态）未接入，零偏目前是软件侧估计。
- 解包的 APK 只作协议参考，不入库。
