import * as Dialog from '@radix-ui/react-dialog';
import { FileCode2, FileText, Folder, Sigma, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { api } from '../api';
import { NotFoundError, humanizeError } from '../api/errors';
import { editUrl, navigate } from '../router';
import { loadTree } from '../store';
import { buildTree, collectDirPaths } from './tree-model';

type TemplateId = 'blank' | 'analysis' | 'math';

const pendingTemplates = new Map<string, string>();

export function consumeNewNoteTemplate(path: string): string | null {
  const val = pendingTemplates.get(path) ?? null;
  pendingTemplates.delete(path);
  return val;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function todayDate(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function defaultStem(): string {
  const now = new Date();
  return `未命名-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

function normalizePath(raw: string): string {
  const cleaned = raw
    .trim()
    .replace(/\.md$/i, '')
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '');
  if (!cleaned) return '';
  const parts = cleaned.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return '';
  return cleaned;
}

function buildTemplateContent(templateId: TemplateId, path: string): string {
  const stem = path.split('/').pop() ?? path;
  const date = todayDate();
  if (templateId === 'analysis') {
    return `---
title: "${stem}"
tags:
  - 研究
updated: ${date}
---

# ${stem}

> [!tip] 💡
> **本页用途：**
> **可信边界：**

## 结论速览

- 

## 详细分析

\`\`\`text

\`\`\`

## 相关笔记

- [[]]
`;
  }
  if (templateId === 'math') {
    return `---
title: "${stem}"
tags:
  - 推导
updated: ${date}
---

# ${stem}

## 问题定义

已知参数 $\\theta$ 与目标函数 $L(\\theta)$：

$$
L(\\theta) = \\frac{1}{n} \\sum_{i=1}^{n} \\ell(f_\\theta(x_i), y_i)
$$

## 推导过程

1. 

## 结论

`;
  }
  return `# ${stem}\n\n`;
}

interface NewNoteModalProps {
  initialDir?: string;
  onDone: () => void;
}

function NewNoteModal({ initialDir, onDone }: NewNoteModalProps) {
  const [open, setOpen] = useState(true);
  const initialPrefix = initialDir ? `${initialDir.replace(/^\/+|\/+$/g, '')}/` : '';
  const [pathInput, setPathInput] = useState(`${initialPrefix}${defaultStem()}`);
  const [template, setTemplate] = useState<TemplateId>('blank');
  const [dirs, setDirs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void loadTree()
      .then((entries) => {
        const tree = buildTree(entries);
        setDirs([...collectDirPaths(tree)].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')));
      })
      .catch(() => undefined);
  }, []);

  const currentStem = useMemo(() => {
    const cleaned = pathInput.trim();
    const lastSlash = cleaned.lastIndexOf('/');
    const stem = lastSlash === -1 ? cleaned : cleaned.slice(lastSlash + 1);
    return stem || defaultStem();
  }, [pathInput]);

  const applyDir = (dir: string): void => {
    setPathInput(dir ? `${dir}/${currentStem}` : currentStem);
    setError(null);
    inputRef.current?.focus();
  };

  const handleOpenChange = (nextOpen: boolean): void => {
    setOpen(nextOpen);
    if (!nextOpen) onDone();
  };

  const handleSubmit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const path = normalizePath(pathInput);
    if (!path) {
      setError('请输入合法的笔记路径，例如「示例库/我的笔记」。');
      inputRef.current?.focus();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      let exists = true;
      try {
        await api.getDoc(path);
      } catch (err) {
        if (err instanceof NotFoundError) exists = false;
        else throw err;
      }
      if (exists) {
        setError('这个路径已经有笔记了，换一个名字或目录吧。');
        setSubmitting(false);
        inputRef.current?.focus();
        return;
      }
      if (template !== 'blank') {
        pendingTemplates.set(path, buildTemplateContent(template, path));
      }
      handleOpenChange(false);
      await navigate(editUrl(path, true));
    } catch (err) {
      setError(humanizeError(err));
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content
          className="modal modal-lg"
          aria-describedby="new-note-desc"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            window.setTimeout(() => {
              const el = inputRef.current;
              if (!el) return;
              el.focus();
              const slashIdx = el.value.lastIndexOf('/');
              el.setSelectionRange(slashIdx + 1, el.value.length);
            }, 0);
          }}
        >
          <div className="modal-header">
            <Dialog.Title className="modal-title" id="new-note-title">
              新建笔记
            </Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="btn-icon" aria-label="关闭弹窗">
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>
          <Dialog.Description id="new-note-desc" className="modal-desc">
            输入存储路径（无需写 <code>.md</code>），可点下方目录快速归类。
          </Dialog.Description>

          <form className="new-note-form" onSubmit={(e) => void handleSubmit(e)}>
            <label className="field-label">
              <span>笔记路径</span>
              <input
                ref={inputRef}
                type="text"
                className="field-input"
                value={pathInput}
                onChange={(e) => {
                  setPathInput(e.target.value);
                  setError(null);
                }}
                placeholder="例如：示例库/我的新笔记"
                autoComplete="off"
                spellCheck={false}
              />
            </label>

            {dirs.length > 0 ? (
              <div className="new-note-dirs">
                <span className="new-note-label">目录快捷填充：</span>
                <div className="dir-chip-list">
                  <button
                    type="button"
                    className={`dir-chip${!pathInput.includes('/') ? ' is-active' : ''}`}
                    onClick={() => applyDir('')}
                  >
                    根目录
                  </button>
                  {dirs.slice(0, 12).map((dir) => (
                    <button
                      key={dir}
                      type="button"
                      className={`dir-chip${pathInput.startsWith(`${dir}/`) ? ' is-active' : ''}`}
                      onClick={() => applyDir(dir)}
                    >
                      <Folder size={12} />
                      <span>{dir}</span>
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="new-note-templates">
              <span className="new-note-label">初始模板：</span>
              <div className="template-grid">
                <button
                  type="button"
                  className={`template-card${template === 'blank' ? ' is-selected' : ''}`}
                  onClick={() => setTemplate('blank')}
                >
                  <FileText size={16} />
                  <div>
                    <div className="template-title">空白笔记</div>
                    <div className="template-desc">只有标题，自由书写</div>
                  </div>
                </button>
                <button
                  type="button"
                  className={`template-card${template === 'analysis' ? ' is-selected' : ''}`}
                  onClick={() => setTemplate('analysis')}
                >
                  <FileCode2 size={16} />
                  <div>
                    <div className="template-title">技术研究 / 逆向</div>
                    <div className="template-desc">含 frontmatter、Callout、代码块</div>
                  </div>
                </button>
                <button
                  type="button"
                  className={`template-card${template === 'math' ? ' is-selected' : ''}`}
                  onClick={() => setTemplate('math')}
                >
                  <Sigma size={16} />
                  <div>
                    <div className="template-title">数学与推导</div>
                    <div className="template-desc">预设 KaTeX 行内与块级公式</div>
                  </div>
                </button>
              </div>
            </div>

            {error ? <p className="field-error" role="alert">{error}</p> : null}

            <div className="modal-actions">
              <Dialog.Close asChild>
                <button type="button" className="btn btn-ghost">
                  取消
                </button>
              </Dialog.Close>
              <button type="submit" className="btn btn-primary" disabled={submitting}>
                {submitting ? '检查中…' : '创建并编辑'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

let activeModalRoot: Root | null = null;
let activeModalHost: HTMLElement | null = null;

export function openNewNoteDialog(initialDir?: string): void {
  if (activeModalRoot) {
    const oldRoot = activeModalRoot;
    const oldHost = activeModalHost;
    activeModalRoot = null;
    activeModalHost = null;
    oldRoot.unmount();
    oldHost?.remove();
  }

  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  activeModalRoot = root;
  activeModalHost = host;

  const cleanup = (): void => {
    if (activeModalRoot === root) {
      activeModalRoot = null;
      activeModalHost = null;
    }
    queueMicrotask(() => {
      root.unmount();
      host.remove();
    });
  };

  root.render(<NewNoteModal initialDir={initialDir} onDone={cleanup} />);
}
