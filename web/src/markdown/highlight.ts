import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import dos from 'highlight.js/lib/languages/dos';
import http from 'highlight.js/lib/languages/http';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import plaintext from 'highlight.js/lib/languages/plaintext';
import powershell from 'highlight.js/lib/languages/powershell';
import python from 'highlight.js/lib/languages/python';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

/**
 * 只注册语料里真实出现的语言（36 篇统计：bash/sh 31 + powershell/pwsh 22 + text 74 +
 * c/java/python/json/xml/cmd/yaml/…），避免把 highlight.js 全量语言（≈1MB）打进 bundle。
 */
const REGISTERED: Array<[string, Parameters<typeof hljs.registerLanguage>[1]]> = [
  ['powershell', powershell],
  ['bash', bash],
  ['python', python],
  ['c', c],
  ['java', java],
  ['javascript', javascript],
  ['json', json],
  ['xml', xml],
  ['yaml', yaml],
  ['dos', dos],
  ['http', http],
  ['plaintext', plaintext],
];

for (const [name, lang] of REGISTERED) hljs.registerLanguage(name, lang);

/** 语料里的语言别名 → highlight.js 语言名。`powershell` 与 `pwsh` 必须是同一个。 */
const ALIASES: Record<string, string> = {
  ps: 'powershell',
  ps1: 'powershell',
  pwsh: 'powershell',
 powershell: 'powershell',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  console: 'bash',
  cmd: 'dos',
  bat: 'dos',
  batch: 'dos',
  dos: 'dos',
  html: 'xml',
  svg: 'xml',
  htm: 'xml',
  js: 'javascript',
  node: 'javascript',
  ts: 'javascript',
  typescript: 'javascript',
  yml: 'yaml',
  py: 'python',
  'c++': 'c',
  h: 'c',
  objc: 'c',
  swift: 'c',
  text: 'plaintext',
  txt: 'plaintext',
  plaintext: 'plaintext',
  '': 'plaintext',
};

/** 把 info string 归一成 highlight.js 语言名（未知语言原样返回，由调用方决定降级）。 */
export function normalizeLanguage(lang: string): string {
  const key = lang.trim().toLowerCase();
  return ALIASES[key] ?? key;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 返回高亮后的 HTML（已转义，可直接插入）。未知语言 / 高亮失败 → 纯转义文本。
 * 注意：这是唯一允许把第三方输出当 HTML 用的地方（highlight.js 自己负责转义）。
 */
export function highlightCode(code: string, rawLang: string): string {
  const lang = normalizeLanguage(rawLang);
  if (!lang || lang === 'plaintext' || !hljs.getLanguage(lang)) {
    return escapeHtml(code);
  }
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

export function hasLanguage(rawLang: string): boolean {
  const lang = normalizeLanguage(rawLang);
  return lang !== 'plaintext' && Boolean(hljs.getLanguage(lang));
}
