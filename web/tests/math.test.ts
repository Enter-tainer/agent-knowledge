import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/markdown';

describe('mathPlugin：KaTeX 数学公式渲染', () => {
  it('渲染行内 $...$ 与单字符变量', () => {
    const html = renderMarkdown('已知 $x$ 和 $E = mc^2$，求 $a_1 + b_2$。');
    expect(html).toContain('class="math-inline"');
    expect(html).toContain('class="katex"');
    expect(html).not.toContain('$E = mc^2$');
  });

  it('渲染行内 \\(...\\) 公式', () => {
    const html = renderMarkdown('当 \\(\\alpha > 0\\) 时成立。');
    expect(html).toContain('class="math-inline"');
    expect(html).toContain('class="katex"');
  });

  it('渲染块级 $$...$$（单行与多行）与 \\[...\\]', () => {
    const single = renderMarkdown('$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$');
    expect(single).toContain('class="math-block"');
    expect(single).toContain('class="katex-display"');

    const multi = renderMarkdown('$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$');
    expect(multi).toContain('class="math-block"');
    expect(multi).toContain('class="katex-display"');

    const bracket = renderMarkdown('\\[\nA^T A x = A^T b\n\\]');
    expect(bracket).toContain('class="math-block"');
    expect(bracket).toContain('class="katex-display"');
  });

  it('不把代码、转义或价格货币符号误判为公式', () => {
    const inlineCode = renderMarkdown('代码里写 `$a + b$` 应原样保留。');
    expect(inlineCode).not.toContain('class="math-inline"');
    expect(inlineCode).toContain('<code>$a + b$</code>');

    const fenced = renderMarkdown('```bash\necho $PATH $HOME\n```');
    expect(fenced).not.toContain('class="math-inline"');
    expect(fenced).toContain('$PATH');

    const price = renderMarkdown('预算为 $100 和 $200 之间，或者 $100+$200。');
    expect(price).not.toContain('class="math-inline"');

    const escaped = renderMarkdown('转义 \\$x\\$ 不是公式。');
    expect(escaped).not.toContain('class="math-inline"');
  });

  it('预处理不破坏公式中的 ** 与中文粗体共存', () => {
    const html = renderMarkdown('**结论：**当 $2^{10} = 1024$ 且 $a**b$ 时成立。');
    expect(html).toContain('<strong>结论：');
    expect(html).toContain('class="math-inline"');
  });

  it('非法 LaTeX 不抛异常（优雅降级）', () => {
    const html = renderMarkdown('错误公式 $\\frac{1$ 不崩。');
    expect(html).toContain('class="math-inline"');
  });
});
