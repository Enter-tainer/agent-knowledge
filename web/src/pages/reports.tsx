import {
  AlertTriangle,
  CheckCircle2,
  DatabaseZap,
  Edit3,
  FilePlus2,
  Link2Off,
  RefreshCw,
  Unlink,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { humanizeError } from '../api/errors';
import type { LinksReport, OrphansResponse, StaleReport, UnresolvedReport } from '../api/types';
import { docUrl, editUrl } from '../router';
import { parentPath } from '../ui/dom';
import { createReactPageView } from '../ui/react-view';
import { toast } from '../ui/shell';
import type { PageView } from '../ui/view';

function asUnresolved(report: LinksReport): UnresolvedReport {
  return 'unresolved' in report ? report : { unresolved: [], count: 0 };
}

interface SectionState<T> {
  status: 'loading' | 'ready' | 'error';
  data?: T;
  error?: unknown;
}

function ReportsPageComponent() {
  const [linksState, setLinksState] = useState<SectionState<UnresolvedReport>>({ status: 'loading' });
  const [orphansState, setOrphansState] = useState<SectionState<OrphansResponse>>({ status: 'loading' });
  const [staleState, setStaleState] = useState<SectionState<StaleReport>>({ status: 'loading' });
  const [reindexing, setReindexing] = useState(false);
  const [resolving, setResolving] = useState(false);

  const loadLinks = useCallback(async () => {
    setLinksState({ status: 'loading' });
    try {
      const report = await api.reportLinks(true);
      setLinksState({ status: 'ready', data: asUnresolved(report) });
    } catch (err) {
      setLinksState({ status: 'error', error: err });
    }
  }, []);

  const loadOrphans = useCallback(async () => {
    setOrphansState({ status: 'loading' });
    try {
      const report = await api.orphans();
      setOrphansState({ status: 'ready', data: report });
    } catch (err) {
      setOrphansState({ status: 'error', error: err });
    }
  }, []);

  const loadStale = useCallback(async () => {
    setStaleState({ status: 'loading' });
    try {
      const report = await api.reportStale();
      setStaleState({ status: 'ready', data: report });
    } catch (err) {
      setStaleState({ status: 'error', error: err });
    }
  }, []);

  useEffect(() => {
    void loadLinks();
    void loadOrphans();
    void loadStale();
  }, [loadLinks, loadOrphans, loadStale]);

  const handleReindex = async (): Promise<void> => {
    setReindexing(true);
    try {
      const res = await api.reindex();
      toast(`索引重建完成：${res.documents} 篇 / ${res.chunks} 块，滞后 ${res.stale} 篇`, 'success');
      await Promise.all([loadStale(), loadLinks()]);
    } catch (err) {
      toast(`重建失败：${humanizeError(err)}`, 'error');
    } finally {
      setReindexing(false);
    }
  };

  const handleResolveLinks = async (): Promise<void> => {
    setResolving(true);
    try {
      const res = await api.resolveLinks();
      toast(`全库双链重解析完成：共 ${res.total} 条链接，未解析 ${res.unresolved} 条`, 'success');
      await Promise.all([loadLinks(), loadOrphans()]);
    } catch (err) {
      toast(`重解析失败：${humanizeError(err)}`, 'error');
    } finally {
      setResolving(false);
    }
  };

  const unresolvedCount = linksState.data?.unresolved?.length ?? 0;
  const orphanCount = orphansState.data?.orphans?.length ?? 0;
  const staleCount = staleState.data?.count ?? 0;

  return (
    <div className="reports-wrap">
      <div className="reports-header">
        <div>
          <h1 className="page-title">知识库健康报告</h1>
          <p className="page-subtitle muted">检查双链完整性、孤岛笔记与全文索引同步状态。</p>
        </div>
        <div className="reports-admin-actions">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={resolving}
            onClick={() => void handleResolveLinks()}
          >
            <RefreshCw size={14} className={resolving ? 'spin' : undefined} />
            <span>{resolving ? '解析中…' : '重解析全库双链'}</span>
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={reindexing}
            onClick={() => void handleReindex()}
          >
            <DatabaseZap size={14} />
            <span>{reindexing ? '重建中…' : '重建全文索引'}</span>
          </button>
        </div>
      </div>

      <div className="reports-metrics">
        <div className={`metric-card${unresolvedCount > 0 ? ' is-warn' : ' is-ok'}`}>
          <div className="metric-label">
            <Link2Off size={15} />
            <span>断链数量</span>
          </div>
          <div className="metric-value">
            {linksState.status === 'ready' ? unresolvedCount : '…'}
          </div>
        </div>
        <div className="metric-card">
          <div className="metric-label">
            <Unlink size={15} />
            <span>无入链笔记</span>
          </div>
          <div className="metric-value">
            {orphansState.status === 'ready' ? orphanCount : '…'}
          </div>
        </div>
        <div className={`metric-card${staleCount > 0 ? ' is-warn' : ' is-ok'}`}>
          <div className="metric-label">
            <AlertTriangle size={15} />
            <span>索引滞后</span>
          </div>
          <div className="metric-value">
            {staleState.status === 'ready' ? staleCount : '…'}
          </div>
        </div>
      </div>

      <section className="report-section">
        {linksState.status === 'loading' ? (
          <div className="report-loading">
            <span className="spinner" />
            <span>正在检查断链…</span>
          </div>
        ) : linksState.status === 'error' ? (
          <div className="report-error" role="alert">
            <h2 className="panel-title">断链检查失败</h2>
            <p className="report-error-text">{humanizeError(linksState.error)}</p>
            <button type="button" className="btn btn-primary" onClick={() => void loadLinks()}>
              重试
            </button>
          </div>
        ) : (
          <div className="panel">
            <h2 className="panel-title">
              <span>断链</span>
              <span className="badge">{unresolvedCount}</span>
            </h2>
            <p className="panel-hint">这些笔记里指向的页面不存在（可直接点击右侧按钮补建或修改源笔记）。</p>
            {unresolvedCount === 0 ? (
              <p className="panel-hint ok">
                <CheckCircle2 size={15} /> 没有断链，所有双链都能正常跳转。
              </p>
            ) : (
              <ul className="report-list">
                {linksState.data!.unresolved.map((item, idx) => (
                  <li key={`${item.src}-${item.target}-${idx}`} className="report-item">
                    <div className="report-item-body">
                      <div className="report-main">
                        <a className="link-title" href={docUrl(item.src)}>
                          {item.title || item.src}
                        </a>
                        <span className="report-line muted">第 {item.line} 行</span>
                      </div>
                      <div className="report-detail">
                        <span className="muted">指向：</span>
                        <span className="link-broken">[[{item.target}]]</span>
                      </div>
                      {parentPath(item.src) ? (
                        <div className="report-path muted">{parentPath(item.src)}</div>
                      ) : null}
                    </div>
                    <div className="report-item-actions">
                      <a
                        className="btn btn-ghost btn-small"
                        href={editUrl(item.target, true)}
                        title={`创建缺失笔记「${item.target}」`}
                      >
                        <FilePlus2 size={13} />
                        <span>创建目标</span>
                      </a>
                      <a
                        className="btn btn-ghost btn-small"
                        href={editUrl(item.src)}
                        title="编辑来源笔记"
                      >
                        <Edit3 size={13} />
                        <span>编辑来源</span>
                      </a>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="report-section">
        {orphansState.status === 'loading' ? (
          <div className="report-loading">
            <span className="spinner" />
            <span>正在统计无入链笔记…</span>
          </div>
        ) : orphansState.status === 'error' ? (
          <div className="report-error" role="alert">
            <h2 className="panel-title">无入链统计失败</h2>
            <p className="report-error-text">{humanizeError(orphansState.error)}</p>
            <button type="button" className="btn btn-primary" onClick={() => void loadOrphans()}>
              重试
            </button>
          </div>
        ) : (
          <div className="panel">
            <h2 className="panel-title">
              <span>无入链笔记</span>
              <span className="badge">{orphanCount}</span>
            </h2>
            <p className="panel-hint">没有任何其他笔记链接到它们，可以考虑从索引页或相关笔记中引入。</p>
            {orphanCount === 0 ? (
              <p className="panel-hint ok">
                <CheckCircle2 size={15} /> 所有笔记都有其他笔记链接到。
              </p>
            ) : (
              <ul className="report-list">
                {orphansState.data!.orphans.map((item) => (
                  <li key={item.path} className="report-item">
                    <div className="report-item-body">
                      <div className="report-main">
                        <a className="link-title" href={docUrl(item.path)}>
                          {item.title || item.path}
                        </a>
                      </div>
                      {parentPath(item.path) ? (
                        <div className="report-path muted">{parentPath(item.path)}</div>
                      ) : null}
                    </div>
                    <div className="report-item-actions">
                      <a className="btn btn-ghost btn-small" href={editUrl(item.path)}>
                        <Edit3 size={13} />
                        <span>编辑</span>
                      </a>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      {staleState.status === 'ready' && staleCount > 0 ? (
        <section className="report-section">
          <div className="panel">
            <h2 className="panel-title">
              <span>索引滞后文档</span>
              <span className="badge badge-warn">{staleCount}</span>
            </h2>
            <p className="panel-hint">这些文档正文已更新但全文搜索索引尚未同步，可点击右上角「重建全文索引」修复。</p>
            <ul className="report-list">
              {staleState.data!.stale.map((item) => (
                <li key={item.path} className="report-item">
                  <div className="report-item-body">
                    <div className="report-main">
                      <a className="link-title" href={docUrl(item.path)}>
                        {item.title || item.path}
                      </a>
                    </div>
                    <div className="report-path muted">{item.path}</div>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>
      ) : null}
    </div>
  );
}

export async function renderReports(): Promise<PageView> {
  return createReactPageView(<ReportsPageComponent />, {
    className: 'reports-page',
    active: 'reports',
    title: '报告 · 私有知识库',
  });
}
