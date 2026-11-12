---
title: "压感与笔输入"
aliases: []
tags:
  - 案例
  - 笔输入
updated: 2026-11-09
---
# 压感与笔输入

> [!tip] 💡
> 结论先行：内核驱动报的是 **原生 10-bit（0..1023）**，宣传的 8192 级在硬件通路上不存在，8192 是软件插值后的观感值。

## 证据链

| 层 | 看到的值 | 说明 |
|-|-|-|
| 内核 `event2` | `ABS_PRESSURE` 0..1023 | 原始分辨率 |
| 官方绘图 App | 0..8191 | Catmull-Rom 插值 + 抖动 |
| 第三方 App | 0..1023 | 直接读原始值 |

## 读取原始压力

```powershell
# mock：用 evtest 观察 event2
adb shell getevent -lt /dev/input/event2
```

```python
def to_mv(raw: int) -> float:
    return raw * 0.0024672
```

## 返回

- [[示例设备 A 逆向]]
- [[示例索引]]
