---
title: "示例设备 B 逆向"
aliases: []
tags:
  - 案例
  - BLE
updated: 2026-11-11
---
# 示例设备 B 逆向

> [!note] ❌
> **本页用途：**mock 案例页，用来验证「未知/带图标的 callout 标题」「表格」「反链」。
> 这里的命令和数值都是编的。

## 帧格式

| offset | size | field | 含义 |
|-|-|-|-|
| 0 | 1 | head | 固定 `0xA5` |
| 1 | 1 | cmd | 命令字 |
| 2 | 1 | cmd_chk | `(~cmd) & 0xFF` <br>用于找帧头 |
| 7 | len | content | 载荷 |

请求与响应同一套帧，整帧长度 = 8 + len。

## 校验

```c
uint8_t crc8_atm(const uint8_t *p, size_t n) {
  uint8_t c = 0;
  while (n--) c = (uint8_t)((c << 1) ^ ((c & 0x80) ? 0x07 : 0));
  return c;
}
```

## 相关

- [[示例设备 A 逆向]]
- [[示例索引]]
