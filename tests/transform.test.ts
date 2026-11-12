import { describe, expect, it } from 'vitest';
import { analyzeQuery, TOKENIZER_VERSION, transformText } from '../src/lib/transform';

describe('transformText（写入端）', () => {
  it('unicode61 的失败被 bigram 修复：连续中文按 2 字切', () => {
    expect(transformText('压感等级与电机').split(' ')).toEqual([
      '压感',
      '感等',
      '等级',
      '级与',
      '与电',
      '电机',
    ]);
  });

  it('单个汉字保留为单 token', () => {
    expect(transformText('压')).toBe('压');
  });

  it('中英混排：ASCII 词 + 中文 bigram', () => {
    expect(transformText('BLE协议').split(' ')).toEqual(['BLE', '协议']);
  });

  it('十六进制拆出数字子 token（0x7000 → 7000）', () => {
    const tokens = transformText('0x7000').split(' ');
    expect(tokens).toContain('0x7000');
    expect(tokens).toContain('7000');
  });

  it('snake_case / camelCase 子 token', () => {
    expect(transformText('ABS_PRESSURE').split(' ')).toEqual(
      expect.arrayContaining(['ABS_PRESSURE', 'ABS', 'PRESSURE']),
    );
    expect(transformText('accountId').split(' ')).toEqual(expect.arrayContaining(['accountId', 'account', 'Id']));
  });

  it('标点会把中文断成两段 bigram（已知限制，对应 C-0）', () => {
    expect(transformText('心率、广播').split(' ')).toEqual(['心率', '广播']);
  });

  it('tokenizer version 有常量（改算法必须 bump）', () => {
    expect(TOKENIZER_VERSION).toBe(1);
  });
});

describe('analyzeQuery（查询端）', () => {
  it('2 字中文 → phrase', () => {
    expect(analyzeQuery('压感').expr).toBe('"压感"');
  });

  it('4 字中文 → bigram phrase', () => {
    expect(analyzeQuery('心率广播').expr).toBe('"心率 率广 广播"');
  });

  it('多词 AND', () => {
    expect(analyzeQuery('压感 等级').expr).toBe('"压感" AND "等级"');
  });

  it('纯 ASCII 标识符 → 前缀（F 方案）', () => {
    expect(analyzeQuery('0x100B51CF').expr).toBe('0x100b51cf*');
    expect(analyzeQuery('LSPosed').expr).toBe('lsposed*');
  });

  it('含分隔符的标识符 → 完整变换序列 phrase（不前缀）', () => {
    expect(analyzeQuery('CVE-2026-98260').expr).toBe('"CVE-2026-98260 CVE 2026 98260"');
  });

  it('中英混排单 token → 一个 phrase', () => {
    expect(analyzeQuery('BLE协议').expr).toBe('"BLE 协议"');
  });

  it('1 字中文：给出 hasShortCjk，不静默失败', () => {
    const q = analyzeQuery('压');
    expect(q.hasShortCjk).toBe(true);
    expect(q.expr).toBe('"压"');
  });

  it('空查询 → 空表达式', () => {
    expect(analyzeQuery('   ').expr).toBe('');
    expect(analyzeQuery('').terms).toEqual([]);
  });

  it('恶意 FTS 语法字符不会原样进入表达式（全部被 token 化/引号包住）', () => {
    for (const q of ['a OR b', 'NEAR(x y)', '*', '"', 'x AND (y)', '-foo', 'a:b']) {
      const expr = analyzeQuery(q).expr;
      // 只允许出现引号包住的内容、前缀 * 与 AND 连接符
      expect(expr.replace(/"[^"]*"|\*|AND|\s|[A-Za-z0-9_.\-/+:]+/g, '')).toBe('');
    }
  });
});
