#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
CJK + code-identifier full-text search benchmark (SQLite FTS5).

Corpus : <workspace>/vault-src  (read-only, never modified)
Output : research/bench/results.json, research/bench/*.sql, research/bench/indexes/*.db

Schemes
  A  unicode61, raw text                     (baseline; the "obvious" choice)
  B  trigram, raw text                       (substring search, <3 chars unusable)
  B2 trigram + LIKE fallback for <3 char tokens (diagnostic variant of B)
  C  bigram pre-tokenisation at write time   (CJK run -> overlapping bigrams, ASCII kept)
  C1 unigram+bigram pre-tokenisation         (diagnostic: adds 1-char CJK support)
  D  C + identifier sub-tokens               (snake_case / camelCase / 0x hex)
  E  hybrid: trigram table + identifier table (unicode61), RRF fusion

Ground truth: file-level, case-insensitive substring match over the whole file.
  mode "substr" -> one substring
  mode "all"    -> every whitespace-separated token must appear (used for queries
                   like "BLE 协议" where a raw substring match would be too strict)

Usage:
    py -3 bench.py                 # build, measure, write results.json + *.sql
    py -3 bench.py --keep-db       # keep .db files even when large
    py -3 bench.py --vault DIR --out DIR
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import statistics
import subprocess
import sys
import time
from pathlib import Path

BENCH_DIR = Path(__file__).resolve().parent
WORKSPACE = BENCH_DIR.parent.parent
DEFAULT_VAULT = WORKSPACE / "vault-src"
# sqlite3 CLI is only used for dbstat (per-table page accounting); Python's bundled
# SQLite is used for everything else. Override with env SQLITE_CLI if needed.
SQLITE_CLI = Path(os.environ.get("SQLITE_CLI", r"C:\Users\mgt\scoop\shims\sqlite3.exe"))
K = 5  # top-k cutoff

# ---------------------------------------------------------------------------
# text utilities
# ---------------------------------------------------------------------------
CJK_RANGES = "\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff"
RUN_RE = re.compile(f"([{CJK_RANGES}]+)|([^{CJK_RANGES}]+)")
WORD_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.\-/+:]*")
CAMEL_RE = re.compile(r"[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+")
HEX_RE = re.compile(r"0[xX][0-9a-fA-F]+")


def runs(text: str):
    """Yield (is_cjk, chunk) covering `text` completely and in order."""
    for m in RUN_RE.finditer(text):
        if m.group(1):
            yield True, m.group(1)
        else:
            yield False, m.group(2)


def bigrams(chunk: str):
    if len(chunk) == 1:
        return [chunk]
    return [chunk[i:i + 2] for i in range(len(chunk) - 1)]


def transform_bigram(text: str) -> str:
    """CJK runs -> overlapping bigrams separated by spaces; everything else kept."""
    out = []
    for is_cjk, chunk in runs(text):
        if is_cjk:
            out.extend(bigrams(chunk))
        else:
            out.append(chunk)
    return " ".join(out)


def transform_unigram_bigram(text: str) -> str:
    out = []
    for is_cjk, chunk in runs(text):
        if is_cjk:
            out.extend(bigrams(chunk))   # bigrams first: keeps phrase adjacency
            out.extend(chunk)            # unigrams in a following block
        else:
            out.append(chunk)
    return " ".join(out)


def ident_subtokens(word: str):
    """Sub-tokens for one ASCII identifier-ish word (the whole word is emitted too)."""
    subs = []
    if HEX_RE.fullmatch(word):
        subs.append(word[2:])                      # 0x7000 -> 7000
    for seg in re.split(r"[_.\-/+:]", word):
        if len(seg) >= 2 and seg != word:
            subs.append(seg)                       # ABS_PRESSURE -> ABS, PRESSURE
        for piece in CAMEL_RE.findall(seg):
            if len(piece) >= 2 and piece not in (seg, word):
                subs.append(piece)                 # accountId -> account, Id
    seen, out = set(), []
    for s in subs:
        if s.lower() not in seen:
            seen.add(s.lower())
            out.append(s)
    return out


def transform_bigram_ident(text: str) -> str:
    out = []
    for is_cjk, chunk in runs(text):
        if is_cjk:
            out.extend(bigrams(chunk))
        else:
            for w in WORD_RE.findall(chunk):
                out.append(w)
                out.extend(ident_subtokens(w))
    return " ".join(out)


def transform_ident_only(text: str) -> str:
    return " ".join(WORD_RE.findall(text))


HEADING_RE = re.compile(r"^#{1,6} ", re.M)


def chunk_markdown(text: str, target: int = 600):
    """Split a markdown file into heading/paragraph chunks of roughly `target` chars.

    Supplementary experiment G only: the primary benchmark is file-level.
    """
    chunks, buf, size = [], [], 0
    for block in re.split(r"\n\s*\n", text):
        block = block.strip()
        if not block:
            continue
        if size and size + len(block) > target and (HEADING_RE.match(block) or size > target // 2):
            chunks.append("\n\n".join(buf))
            buf, size = [], 0
        buf.append(block)
        size += len(block)
    if buf:
        chunks.append("\n\n".join(buf))
    return chunks


def quote(token: str) -> str:
    return '"' + token.replace('"', '""') + '"'


def expr_raw(query: str) -> str:
    """A/B style: every whitespace-separated token quoted, AND-joined."""
    return " AND ".join(quote(t) for t in query.split() if t)


def expr_bigram(query: str) -> str:
    """C/C1/D style: same transform as the index, CJK run -> phrase of bigrams."""
    parts = []
    for is_cjk, chunk in runs(query):
        if is_cjk:
            parts.append(quote(" ".join(bigrams(chunk))))
        else:
            for w in WORD_RE.findall(chunk):
                parts.append(quote(w))
    return " AND ".join(parts)


# ---------------------------------------------------------------------------
# query set: 53 queries over 10 categories
# ---------------------------------------------------------------------------
# mode "all" -> every whitespace token must occur in the file (multi-word queries)
QUERIES = [
    # 1-char CJK: does the scheme support single-character lookup at all?
    ("压", "substr", "cjk_1char", "24 files; bigram-only index has no unigram"),
    ("笔", "substr", "cjk_1char", "16 files"),
    # 2-char CJK: the acceptance criterion that matters most
    ("压感", "substr", "cjk_2char", "8 files; trigram cannot do this"),
    ("校准", "substr", "cjk_2char", "7 files"),
    ("蓝牙", "substr", "cjk_2char", "11 files"),
    ("笔效", "substr", "cjk_2char", "5 files"),
    ("噪声", "substr", "cjk_2char", "2 files"),
    ("电机", "substr", "cjk_2char_neg", "0 files -> must return nothing"),
    # 3-char CJK
    ("笔输入", "substr", "cjk_3char", "5 files"),
    ("固件包", "substr", "cjk_3char", "5 files"),
    ("导航栏", "substr", "cjk_3char", "6 files"),
    # 4-char CJK
    ("心率广播", "substr", "cjk_4char", "5 files"),
    ("数据出境", "substr", "cjk_4char", "4 files"),
    ("分区备份", "substr", "cjk_4char", "4 files"),
    ("面部追踪", "substr", "cjk_4char", "4 files"),
    ("重签装机", "substr", "cjk_4char", "5 files"),
    ("拼音引擎", "substr", "cjk_4char", "4 files"),
    ("协议逆向", "substr", "cjk_4char", "6 files"),
    ("单导心电", "substr", "cjk_4char", "11 files"),
    ("凭据复现", "substr", "cjk_4char", "4 files"),
    ("固件升级", "substr", "cjk_4char", "6 files"),
    # nonexistent CJK: silent-zero / false-positive check
    ("磁吸", "substr", "cjk_neg", "0 files"),
    ("量子纠缠", "substr", "cjk_neg", "0 files"),
    ("压感等级", "substr", "cjk_neg", "0 files (corpus says 8192 压感, not 压感等级)"),
    # ASCII identifiers, exact token
    ("HALL", "substr", "ident_exact", "6 files, but every occurrence is inside 'challenge' -- "
                                       "substring GT counts it, token schemes do not"),
    ("LSPosed", "substr", "ident_exact", "6 files"),
    ("iAP2", "substr", "ident_exact", "4 files"),
    ("nxnative", "substr", "ident_exact", "5 files"),
    ("Magisk", "substr", "ident_exact", "9 files"),
    ("protobuf", "substr", "ident_exact", "7 files"),
    ("CRC16", "substr", "ident_exact", "5 files"),
    ("Info.plist", "substr", "ident_exact", "5 files"),
    ("Mach-O", "substr", "ident_exact", "5 files"),
    ("ActivityTaskManager", "substr", "ident_exact", "1 file"),
    ("ABS_PRESSURE", "substr", "ident_exact", "4 files"),
    ("access_token", "substr", "ident_exact", "1 file"),
    ("2.6.55", "substr", "ident_exact", "4 files"),
    ("boot.img", "substr", "ident_exact", "4 files"),
    ("vbmeta", "substr", "ident_exact", "3 files"),
    # hex / CVE / numeric-id style
    ("0x7000", "substr", "hex", "4 files"),
    ("0x100B51CF", "substr", "hex", "1 file; corpus actually contains the LONGER token 0x100B51CF4"),
    ("0x100B51CF4", "substr", "hex", "1 file; exact full token (contrast with 0x100B51CF)"),
    ("CVE-2026-98260", "substr", "hex", "4 files"),
    ("7000", "substr", "hex", "7 files; only reachable as a sub-token of 0x7000 / substring of 0x1000706CC"),
    # identifier sub-token (camelCase / snake_case fragment)
    ("account", "substr", "camel_sub", "2 files (accountId / account_id)"),
    ("diagnosis", "substr", "camel_sub", "1 file (aiDiagnosis)"),
    ("Accessory", "substr", "camel_sub", "1 file (iAP2Accessory)"),
    ("pressure", "substr", "camel_sub", "6 files (ABS_PRESSURE ...)"),
    # CJK + ASCII mixed / multi word
    ("BLE 协议", "all", "mixed", "16 files (BLE AND 协议)"),
    ("EBC 驱动", "all", "mixed", "10 files"),
    ("LSPosed 导航栏", "all", "mixed", "6 files (both terms real identifiers/words)"),
    ("心率 广播", "all", "mixed", "8 files"),
    # ASCII strings that do not exist
    ("SSL Pinning", "all", "ascii_neg", "0 files"),
    ("handleHIDReport", "all", "ascii_neg", "0 files"),
    ("zzqxnotexist", "substr", "ascii_neg", "0 files"),
]

CATEGORIES = [
    ("cjk_1char", "1-char CJK"),
    ("cjk_2char", "2-char CJK"),
    ("cjk_3char", "3-char CJK"),
    ("cjk_4char", "4+ char CJK"),
    ("cjk_2char_neg", "2-char CJK, absent"),
    ("cjk_neg", "CJK absent"),
    ("ident_exact", "identifier exact"),
    ("hex", "hex / CVE / numeric"),
    ("camel_sub", "identifier sub-token"),
    ("mixed", "CJK+ASCII multi-word"),
    ("ascii_neg", "ASCII absent"),
]


# ---------------------------------------------------------------------------
# schemes
# ---------------------------------------------------------------------------
class Scheme:
    """One index + its search strategy."""

    def __init__(self, key, label, ddl, transform, search, query_sql, notes="", tables=None,
                 chunker=None, store_raw=False):
        self.key = key
        self.label = label
        self.ddl = ddl              # list[str] of SQL statements, executed in order
        self.transform = transform  # text -> indexed text (None = raw)
        self.search = search        # (conn, query) -> list[(path, score)]
        self.query_sql = query_sql  # representative SQL for the *.sql file
        self.notes = notes
        self.tables = tables or [f"docs_{key.lower()}"]
        self.chunker = chunker      # None = one row per file
        self.store_raw = store_raw  # keep the original text next to the index


def search_match(table):
    def _search(conn, query):
        exprs = expr_raw(query) if table in ("docs_a", "docs_b") else expr_bigram(query)
        if not exprs:
            return []
        sql = (f"SELECT path, bm25({table}) AS s FROM {table} "
               f"WHERE {table} MATCH ? ORDER BY s LIMIT ?")
        return [(r[0], r[1]) for r in conn.execute(sql, (exprs, K))]
    return _search


PREFIX_OK_RE = re.compile(r"[A-Za-z0-9_]+")


def expr_bigram_prefix(query: str) -> str:
    """D/F style query, but ASCII identifier tokens become prefix queries.

    Why: notes contain 0x100B51CF4 / accountIdV2 etc.; an exact-token search for
    0x100B51CF or account cannot match them, while `0x100b51cf*` can.
    """
    parts = []
    for is_cjk, chunk in runs(query):
        if is_cjk:
            parts.append(quote(" ".join(bigrams(chunk))))
        else:
            for w in WORD_RE.findall(chunk):
                if PREFIX_OK_RE.fullmatch(w) and len(w) >= 2:
                    parts.append(w + "*")
                else:
                    parts.append(quote(w))
    return " AND ".join(parts)


def search_match_prefix(table):
    def _search(conn, query):
        exprs = expr_bigram_prefix(query)
        if not exprs:
            return []
        sql = (f"SELECT path, bm25({table}) AS s FROM {table} "
               f"WHERE {table} MATCH ? ORDER BY s LIMIT ?")
        return [(r[0], r[1]) for r in conn.execute(sql, (exprs, K))]
    return _search


def search_match_prefix_postfilter(table):
    """F + verification: keep only rows whose ORIGINAL text really contains every query token.

    Tokenizers fold separators, so `access_token` can match a doc that only says
    "access token". Verifying the top-N candidates against the stored raw text removes
    that class of false positive for a few string comparisons.
    """
    def _search(conn, query):
        exprs = expr_bigram_prefix(query)
        if not exprs:
            return []
        sql = (f"SELECT path, raw, bm25({table}) AS s FROM {table} "
               f"WHERE {table} MATCH ? ORDER BY s LIMIT ?")
        toks = [t.casefold() for t in query.split()]
        out = []
        for path, raw, _s in conn.execute(sql, (exprs, 50)):
            low = (raw or "").casefold()
            if all(t in low for t in toks):
                out.append((path, None))
                if len(out) >= K:
                    break
        return out
    return _search


def search_match_prefix_chunked(table):
    """Like F, but many rows per file (chunks); collapse hits to a file ranking."""
    def _search(conn, query):
        exprs = expr_bigram_prefix(query)
        if not exprs:
            return []
        sql = (f"SELECT path, bm25({table}) AS s FROM {table} "
               f"WHERE {table} MATCH ? ORDER BY s LIMIT ?")
        out, seen = [], set()
        for path, score in conn.execute(sql, (exprs, 200)):
            if path in seen:
                continue
            seen.add(path)
            out.append((path, score))
            if len(out) >= K:
                break
        return out
    return _search


def search_trigram_like(conn, query):
    """B2: trigram MATCH where possible, LIKE scan for tokens shorter than 3 chars."""
    match_terms, like_terms = [], []
    for t in query.split():
        if len(t) >= 3:
            match_terms.append(quote(t))
        else:
            like_terms.append(t)
    where, args = [], []
    if match_terms:
        where.append("docs_b MATCH ?")
        args.append(" AND ".join(match_terms))
    for t in like_terms:
        where.append("body LIKE '%' || ? || '%'")
        args.append(t)
    if not where:
        return []
    order = "bm25(docs_b)" if match_terms else "path"
    sql = f"SELECT path, {order if match_terms else 'NULL'} AS s FROM docs_b WHERE {' AND '.join(where)} ORDER BY s LIMIT ?"
    args.append(K)
    return [(r[0], r[1]) for r in conn.execute(sql, args)]


def rrf(lists, k=60):
    score = {}
    for lst in lists:
        for rank, path in enumerate(lst):
            score[path] = score.get(path, 0.0) + 1.0 / (k + rank + 1)
    return [p for p, _ in sorted(score.items(), key=lambda kv: -kv[1])][:K]


def search_hybrid(conn, query):
    e = expr_raw(query)
    tri = []
    if e:
        tri = [r[0] for r in conn.execute(
            "SELECT path FROM docs_b WHERE docs_b MATCH ? ORDER BY bm25(docs_b) LIMIT ?", (e, 50))]
    ident = []
    if e:
        ident = [r[0] for r in conn.execute(
            "SELECT path FROM docs_e WHERE docs_e MATCH ? ORDER BY bm25(docs_e) LIMIT ?", (e, 50))]
    merged = rrf([tri, ident])
    return [(p, None) for p in merged]


SCHEMES = [
    Scheme(
        "A", "A unicode61 (baseline)",
        ["CREATE VIRTUAL TABLE docs_a USING fts5(path UNINDEXED, body, tokenize='unicode61 remove_diacritics 2')"],
        None, search_match("docs_a"),
        "SELECT path FROM docs_a WHERE docs_a MATCH :expr ORDER BY bm25(docs_a) LIMIT 5;",
        "Contiguous CJK run collapses into ONE token, so a 2-char query can only match "
        "when the whole run is exactly 2 chars.",
    ),
    Scheme(
        "B", "B trigram",
        ["CREATE VIRTUAL TABLE docs_b USING fts5(path UNINDEXED, body, tokenize='trigram')"],
        None, search_match("docs_b"),
        "SELECT path FROM docs_b WHERE docs_b MATCH :expr ORDER BY bm25(docs_b) LIMIT 5;",
        "Substring search, but any term shorter than 3 characters silently matches nothing.",
        tables=["docs_b"],
    ),
    Scheme(
        "B2", "B+ trigram with LIKE fallback",
        ["CREATE VIRTUAL TABLE docs_b USING fts5(path UNINDEXED, body, tokenize='trigram')"],
        None, search_trigram_like,
        "-- long terms: docs_b MATCH ; short terms: body LIKE '%'||?||'%'\n"
        "SELECT path FROM docs_b WHERE docs_b MATCH :expr AND body LIKE '%'||:short||'%' LIMIT 5;",
        "Diagnostic variant: keeps trigram substring power but rescues <3-char tokens with LIKE "
        "(unindexed scan, no bm25 ordering when only LIKE terms remain).",
        tables=["docs_b"],
    ),
    Scheme(
        "C", "C bigram pre-tokenised",
        ["CREATE VIRTUAL TABLE docs_c USING fts5(path UNINDEXED, body, tokenize='unicode61 remove_diacritics 2')"],
        transform_bigram, search_match("docs_c"),
        "-- body written as: CJK run 心率广播 -> '心率 率广 广播', ASCII kept as-is\n"
        "SELECT path FROM docs_c WHERE docs_c MATCH '\"心率 率广 广播\"' ORDER BY bm25(docs_c) LIMIT 5;",
        "Write-time CJK bigrams; query side must apply the identical transform and use a phrase.",
    ),
    Scheme(
        "C1", "C1 unigram+bigram",
        ["CREATE VIRTUAL TABLE docs_c1 USING fts5(path UNINDEXED, body, tokenize='unicode61 remove_diacritics 2')"],
        transform_unigram_bigram, search_match("docs_c1"),
        "SELECT path FROM docs_c1 WHERE docs_c1 MATCH '\"压\"' ORDER BY bm25(docs_c1) LIMIT 5;",
        "Diagnostic: extra unigrams buy 1-char CJK lookup at a large index cost.",
    ),
    Scheme(
        "D", "D bigram + identifier sub-tokens",
        ["CREATE VIRTUAL TABLE docs_d USING fts5(path UNINDEXED, body, tokenize='unicode61 remove_diacritics 2')"],
        transform_bigram_ident, search_match("docs_d"),
        "SELECT path FROM docs_d WHERE docs_d MATCH '\"account\"' ORDER BY bm25(docs_d) LIMIT 5;",
        "C plus 0x7000->7000, ABS_PRESSURE->ABS/PRESSURE, accountId->account/Id.",
    ),
    Scheme(
        "F", "F D + identifier prefix queries",
        ["CREATE VIRTUAL TABLE docs_f USING fts5(path UNINDEXED, body, tokenize='unicode61 remove_diacritics 2')"],
        transform_bigram_ident, search_match_prefix("docs_f"),
        "-- same index as D; ASCII identifier tokens are searched as prefixes\n"
        "SELECT path FROM docs_f WHERE docs_f MATCH '0x100b51cf*' ORDER BY bm25(docs_f) LIMIT 5;",
        "D's index + `token*` for ASCII identifiers: catches 0x100B51CF4 / accountIdV2 variants.",
    ),
    Scheme(
        "G", "G F at paragraph level (supplementary)",
        ["CREATE VIRTUAL TABLE docs_g USING fts5(path UNINDEXED, body, tokenize='unicode61 remove_diacritics 2')"],
        transform_bigram_ident, search_match_prefix_chunked("docs_g"),
        "-- one row per ~600-char heading/paragraph chunk; hits collapsed to files\n"
        "SELECT path, bm25(docs_g) FROM docs_g WHERE docs_g MATCH '0x100b51cf*' ORDER BY 2 LIMIT 200;",
        "SUPPLEMENTARY experiment: same transform as F, but indexed per paragraph so bm25 "
        "sees local term density. Tests whether chunking fixes the ranking ceiling.",
        tables=["docs_g"], chunker=chunk_markdown,
    ),
    Scheme(
        "H", "H F + raw-text post-filter",
        ["CREATE VIRTUAL TABLE docs_h USING fts5(path UNINDEXED, body, raw UNINDEXED, tokenize='unicode61 remove_diacritics 2')"],
        transform_bigram_ident, search_match_prefix_postfilter("docs_h"),
        "-- candidate list from FTS, then verify every query token against the stored original\n"
        "SELECT path, raw, bm25(docs_h) FROM docs_h WHERE docs_h MATCH 'access_token*' ORDER BY 3 LIMIT 50;",
        "F plus a top-50 verification pass on the original text: kills separator-folding false "
        "positives (access_token vs 'access token') for a few string comparisons.",
        tables=["docs_h"], store_raw=True,
    ),
    Scheme(
        "E", "E hybrid trigram + identifier table",
        [
            "CREATE VIRTUAL TABLE docs_b USING fts5(path UNINDEXED, body, tokenize='trigram')",
            "CREATE VIRTUAL TABLE docs_e USING fts5(path UNINDEXED, body, tokenize='unicode61 remove_diacritics 2')",
        ],
        None, search_hybrid,
        "-- docs_e.body holds only ASCII identifier tokens, space separated\n"
        "-- final ranking = reciprocal rank fusion of the two result lists\n"
        "SELECT path FROM docs_b WHERE docs_b MATCH :expr ORDER BY bm25(docs_b) LIMIT 50;  -- + docs_e --",
        "Keeps trigram substring recall, adds exact-token identifier ranking. bm25 only inside components.",
        tables=["docs_b", "docs_e"],
    ),
]


# ---------------------------------------------------------------------------
# corpus / ground truth
# ---------------------------------------------------------------------------
def load_corpus(vault: Path):
    docs = {}
    for p in sorted(vault.rglob("*.md")):
        rel = p.relative_to(vault).as_posix()
        docs[rel] = p.read_text(encoding="utf-8", errors="replace")
    return docs


def ground_truth(docs, query, mode):
    cf = {k: v.casefold() for k, v in docs.items()}
    if mode == "all":
        toks = [t.casefold() for t in query.split()]
        return sorted(k for k, v in cf.items() if all(t in v for t in toks))
    return sorted(k for k, v in cf.items() if query.casefold() in v)


# ---------------------------------------------------------------------------
# build / measure
# ---------------------------------------------------------------------------
def build_scheme(scheme: Scheme, docs, db_path: Path):
    if db_path.exists():
        db_path.unlink()
    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=OFF")
    conn.execute("PRAGMA synchronous=OFF")
    t0 = time.perf_counter()
    for stmt in scheme.ddl:
        conn.execute(stmt)
    transform_ms = 0.0
    rows = []
    for rel, text in docs.items():
        tt = time.perf_counter()
        if scheme.chunker:
            blocks = [(rel, scheme.transform(ch) if scheme.transform else ch, ch)
                      for ch in scheme.chunker(text)]
        elif scheme.transform is None:
            blocks = [(rel, text, text)]
        else:
            blocks = [(rel, scheme.transform(text), text)]
        transform_ms += (time.perf_counter() - tt) * 1000.0
        rows.extend(blocks)
    t1 = time.perf_counter()
    if len(scheme.ddl) > 1:  # hybrid: second table holds identifier text
        conn.executemany("INSERT INTO docs_b(path, body) VALUES (?, ?)",
                         [(r[0], r[1]) for r in rows])
        conn.executemany("INSERT INTO docs_e(path, body) VALUES (?, ?)",
                         [(rel, transform_ident_only(text)) for rel, text in docs.items()])
    elif scheme.store_raw:
        table = scheme.tables[0]
        conn.executemany(f"INSERT INTO {table}(path, body, raw) VALUES (?, ?, ?)", rows)
    else:
        table = scheme.tables[0]
        conn.executemany(f"INSERT INTO {table}(path, body) VALUES (?, ?)",
                         [(r[0], r[1]) for r in rows])
    conn.commit()
    t2 = time.perf_counter()
    conn.close()
    return {
        "build_ms": round((t2 - t0) * 1000.0, 2),
        "transform_ms": round(transform_ms, 2),
        "insert_ms": round((t2 - t1) * 1000.0, 2),
        "db_bytes": db_path.stat().st_size,
    }


def dbstat(db_path: Path, fts_prefixed: tuple):
    """Return (total_bytes, fts_bytes, per_table) using the sqlite3 CLI dbstat vtab."""
    sql = "SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC"
    info = {"available": False, "total": db_path.stat().st_size, "fts": None, "tables": {}}
    if not SQLITE_CLI.exists():
        return info
    try:
        out = subprocess.run([str(SQLITE_CLI), "-json", str(db_path), sql],
                             capture_output=True, text=True, encoding="utf-8", timeout=120)
        if out.returncode != 0:
            return info
        rows = json.loads(out.stdout or "[]")
        tables = {r["name"]: int(r["bytes"]) for r in rows}
        info["available"] = True
        info["tables"] = tables
        info["total"] = sum(tables.values())
        info["fts"] = sum(v for n, v in tables.items()
                          if any(n == p or n.startswith(p + "_") for p in fts_prefixed))
    except Exception:
        pass
    return info


def median_query_time(conn, search, queries, repeats=5):
    times, failures = [], {}
    for q in queries:
        best = None
        for _ in range(repeats):
            t0 = time.perf_counter()
            try:
                search(conn, q)
            except Exception as e:  # pragma: no cover
                failures[q] = f"{type(e).__name__}: {e}"
                best = None
                break
            dt = (time.perf_counter() - t0) * 1000.0
            best = dt if best is None else min(best, dt)
        if best is not None:
            times.append(best)
    if not times:
        return None, failures
    return {
        "median_ms": round(statistics.median(times), 3),
        "p95_ms": round(sorted(times)[max(0, int(len(times) * 0.95) - 1)], 3),
        "max_ms": round(max(times), 3),
    }, failures


def choose_canonical(gt, query, docs, mode):
    """The single file a human would call "the right answer" for this query.

    Rule (deterministic, documented in README):
      1. a GT file whose path (case-insensitive, spaces removed) contains the query
         (spaces removed too); ties -> shortest path
      2. otherwise the GT file with the most occurrences of the query term
    Returns None for queries with no GT.
    """
    if not gt:
        return None
    needle = query.replace(" ", "").casefold() if mode == "all" else query.casefold()
    named = [p for p in gt if needle in p.casefold().replace(" ", "")]
    if named:
        return min(named, key=lambda p: (len(p), p))
    term = query.casefold() if mode != "all" else query.split()[0].casefold()
    return max(gt, key=lambda p: (docs[p].casefold().count(term), -len(p)))


def evaluate(conn, search, docs, entries, k=K):
    per_query = []
    hits = {1: 0, 3: 0, 5: 0}
    canons = {1: 0, 3: 0, 5: 0}
    positive = 0
    prec, recall, gtcov = [], [], []
    neg_fp = {}
    for q, mode, cat, note in entries:
        gt = ground_truth(docs, q, mode)
        canon = choose_canonical(gt, q, docs, mode)
        try:
            res = search(conn, q)
            err = None
        except Exception as e:
            res, err = [], f"{type(e).__name__}: {e}"
        paths = [p for p, _ in res]
        gt_set = set(gt)
        rec = {
            "query": q, "category": cat, "mode": mode, "gt_count": len(gt),
            "canonical": canon, "returned": paths, "error": err,
        }
        if gt:
            positive += 1
            for n in (1, 3, 5):
                if gt_set & set(paths[:n]):
                    hits[n] += 1
                if canon in paths[:n]:
                    canons[n] += 1
            rec["hit"] = {n: bool(gt_set & set(paths[:n])) for n in (1, 3, 5)}
            rec["canonical_hit"] = {n: canon in paths[:n] for n in (1, 3, 5)}
            rec["canonical_rank"] = (paths.index(canon) + 1) if canon in paths else None
            top5 = paths[:5]
            if top5:
                prec.append(len(gt_set & set(top5)) / len(top5))
            rec["recall@5"] = round(len(gt_set & set(paths[:5])) / min(5, len(gt_set)), 3)
            rec["gt_coverage@5"] = round(len(gt_set & set(paths[:5])) / len(gt_set), 3)
            recall.append(rec["recall@5"])
            gtcov.append(rec["gt_coverage@5"])
        else:
            neg_fp[q] = {"category": cat, "returned": paths, "count": len(paths)}
            rec["false_positive"] = len(paths) > 0
        per_query.append(rec)
    return {
        "positive_queries": positive,
        "hit@1": round(hits[1] / positive, 4) if positive else None,
        "hit@3": round(hits[3] / positive, 4) if positive else None,
        "hit@5": round(hits[5] / positive, 4) if positive else None,
        "canonical@1": round(canons[1] / positive, 4) if positive else None,
        "canonical@3": round(canons[3] / positive, 4) if positive else None,
        "canonical@5": round(canons[5] / positive, 4) if positive else None,
        "precision@5": round(statistics.mean(prec), 4) if prec else None,
        "recall@5": round(statistics.mean(recall), 4) if recall else None,
        "gt_coverage@5": round(statistics.mean(gtcov), 4) if gtcov else None,
        "no_result_queries": len(neg_fp),
        "no_result_false_positives": sum(1 for v in neg_fp.values() if v["count"] > 0),
        "no_result_detail": neg_fp,
    }, per_query


def per_category(per_query):
    out = {}
    for cat, label in CATEGORIES:
        rows = [r for r in per_query if r["category"] == cat]
        pos = [r for r in rows if r["gt_count"] > 0]
        if not pos:
            out[cat] = {"label": label, "queries": len(rows), "positive": 0}
            continue
        out[cat] = {
            "label": label,
            "queries": len(rows),
            "positive": len(pos),
            "hit@1": round(sum(r["hit"][1] for r in pos) / len(pos), 3),
            "hit@3": round(sum(r["hit"][3] for r in pos) / len(pos), 3),
            "hit@5": round(sum(r["hit"][5] for r in pos) / len(pos), 3),
            "canonical@1": round(sum(r["canonical_hit"][1] for r in pos) / len(pos), 3),
            "canonical@3": round(sum(r["canonical_hit"][3] for r in pos) / len(pos), 3),
            "canonical@5": round(sum(r["canonical_hit"][5] for r in pos) / len(pos), 3),
            "recall@5": round(statistics.mean([r["recall@5"] for r in pos]), 3),
            "gt_coverage@5": round(statistics.mean([r["gt_coverage@5"] for r in pos]), 3),
        }
    return out


def bm25_probe(conn, table, expr_fn, candidates=("压感", "协议", "固件", "LSPosed", "0x7000", "CRC16")):
    """Is bm25() accepted on this table, and does it yield float scores?"""
    for q in candidates:
        e = expr_fn(q)
        if not e:
            continue
        try:
            rows = conn.execute(
                f"SELECT path, bm25({table}) FROM {table} "
                f"WHERE {table} MATCH ? ORDER BY bm25({table}) LIMIT 3", (e,)).fetchall()
        except Exception as ex:
            return {"usable": False, "error": f"{type(ex).__name__}: {ex}", "probe_query": q}
        if rows:
            return {"usable": True, "returned": len(rows), "probe_query": q,
                    "scores_are_floats": all(isinstance(r[1], float) for r in rows)}
    return {"usable": True, "returned": 0, "probe_query": None, "scores_are_floats": None,
            "note": "bm25() accepted, but none of the probe queries matched"} 


# ---------------------------------------------------------------------------
# micro checks: pin down the exact FTS5 behaviours the report depends on
# ---------------------------------------------------------------------------
def _micro_table(ddl, table, rows, transform=None):
    conn = sqlite3.connect(":memory:")
    conn.execute(ddl)
    for path, text in rows:
        conn.execute(f"INSERT INTO {table}(path, body) VALUES (?, ?)",
                     (path, transform(text) if transform else text))
    return conn


def _micro_count(conn, table, expr):
    try:
        n = len(conn.execute(f"SELECT path FROM {table} WHERE {table} MATCH ?", (expr,)).fetchall())
        return n, None
    except Exception as e:
        return 0, f"{type(e).__name__}: {e}"


def micro_checks():
    """Small in-memory reproductions of every behaviour the conclusions rest on."""
    out = []

    def add(cid, what, expected, got, err=None):
        out.append({"id": cid, "what": what, "expected_rows": expected,
                    "got_rows": got, "pass": got == expected and err is None,
                    "error": err})

    ddl_u = "CREATE VIRTUAL TABLE t USING fts5(path UNINDEXED, body, tokenize='unicode61 remove_diacritics 2')"
    ddl_t = "CREATE VIRTUAL TABLE t USING fts5(path UNINDEXED, body, tokenize='trigram')"

    # --- unicode61: a contiguous CJK run is ONE token
    c = _micro_table(ddl_u, "t", [("f1", "8192 压感等级与电机")])
    n, e = _micro_count(c, "t", '"压感"')
    add("A-1", "unicode61: doc has '压感等级与电机', query 压感", 0, n, e)
    n, e = _micro_count(c, "t", '"压感等级与电机"')
    add("A-2", "unicode61: same doc, query the whole run", 1, n, e)
    c.close()

    # --- trigram: <3 chars silently matches nothing; LIKE fallback works
    c = _micro_table(ddl_t, "t", [("f1", "8192 压感等级与电机")])
    n, e = _micro_count(c, "t", '"压感"')
    add("B-1", "trigram: query 压感 (2 chars) against a doc containing it", 0, n, e)
    n, e = _micro_count(c, "t", '"压"')
    add("B-2", "trigram: query 压 (1 char)", 0, n, e)
    n, e = _micro_count(c, "t", '"压感等"')
    add("B-3", "trigram: query 压感等 (3 chars)", 1, n, e)
    n = len(c.execute("SELECT path FROM t WHERE body LIKE '%' || ? || '%'", ("压感",)).fetchall())
    add("B-4", "trigram table + LIKE '%压感%' fallback", 1, n)
    c.close()

    # --- C bigram: works for 2+ chars, fails on 1 char, breaks across punctuation
    c = _micro_table(ddl_u, "t", [("f1", "心率广播固件逆向"), ("f2", "心率、广播两路")],
                     transform=transform_bigram)
    n, e = _micro_count(c, "t", expr_bigram("心率广播"))
    add("C-1", "bigram: doc '心率广播固件逆向', query 心率广播", 1, n, e)
    n, e = _micro_count(c, "t", expr_bigram("心率 广播"))
    add("C-2", "bigram: query '心率 广播' (space) also finds doc '心率、广播两路'", 2, n, e)
    c2 = _micro_table(ddl_u, "t", [("f2", "心率、广播两路")], transform=transform_bigram)
    n, e = _micro_count(c2, "t", expr_bigram("心率广播"))
    add("C-0", "bigram: doc writes '心率、广播', query 心率广播 (no punctuation) -> positional gap", 0, n, e)
    n, e = _micro_count(c2, "t", expr_bigram("心率、广播"))
    add("C-6", "bigram: query '心率、广播' (punctuation kept) -> two phrases AND'd", 1, n, e)
    c2.close()
    n, e = _micro_count(c, "t", expr_bigram("率广"))
    add("C-3", "bigram: non-word 2-char slice 率广 matches inside 心率广播 (false-positive surface)", 1, n, e)
    n, e = _micro_count(c, "t", expr_bigram("压"))
    add("C-4", "bigram: 1-char query 压 -> nothing (no unigram in index)", 0, n, e)
    c.close()

    c = _micro_table(ddl_u, "t", [("f1", "字段 accountId")], transform=transform_bigram)
    n, e = _micro_count(c, "t", expr_bigram("account"))
    add("C-5", "bigram: query account against doc 'accountId' -> no sub-token splitting", 0, n, e)
    c.close()

    c = _micro_table(ddl_u, "t", [("f1", "8192 压感")], transform=transform_unigram_bigram)
    n, e = _micro_count(c, "t", expr_bigram("压"))
    add("C1-1", "unigram+bigram: 1-char query 压", 1, n, e)
    c.close()

    # --- D: identifier sub-tokens
    c = _micro_table(ddl_u, "t", [("f1", "ioctl 0x7000 与 0x100B51CF4"),
                                  ("f2", "字段 accountId 与 ABS_PRESSURE")],
                     transform=transform_bigram_ident)
    for q, exp, cid in (
        ("7000", 1, "D-1"),
        ("0x7000", 1, "D-2"),
        ("account", 1, "D-3"),
        ("accountId", 1, "D-4"),
        ("PRESSURE", 1, "D-5"),
        ("0x100B51CF", 0, "D-6"),
    ):
        n, e = _micro_count(c, "t", expr_bigram(q))
        add(cid, f"D: query {q}", exp, n, e)
    c.close()

    # --- F: the same index, but ASCII identifiers are prefix queries
    c = _micro_table(ddl_u, "t", [("f1", "ioctl 0x7000 与 0x100B51CF4")],
                     transform=transform_bigram_ident)
    n, e = _micro_count(c, "t", expr_bigram_prefix("0x100B51CF"))
    add("F-1", "D index + prefix query 0x100B51CF*", 1, n, e)
    n, e = _micro_count(c, "t", expr_bigram_prefix("0x7000"))
    add("F-2", "D index + prefix query 0x7000*", 1, n, e)
    c.close()

    # --- A/D: exact identifier token required
    c = _micro_table(ddl_u, "t", [("f1", "ioctl 0x7000")])
    n, e = _micro_count(c, "t", expr_raw("7000"))
    add("A-3", "unicode61: query 7000 against doc '0x7000'", 0, n, e)
    c.close()

    return out


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--vault", default=str(DEFAULT_VAULT))
    ap.add_argument("--out", default=str(BENCH_DIR))
    ap.add_argument("--keep-db", action="store_true")
    ap.add_argument("--max-db-mb", type=float, default=5.0)
    args = ap.parse_args()

    vault = Path(args.vault).resolve()
    out = Path(args.out).resolve()
    idx_dir = out / "indexes"
    idx_dir.mkdir(parents=True, exist_ok=True)

    docs = load_corpus(vault)
    corpus_bytes = sum(len(v.encode("utf-8")) for v in docs.values())
    print(f"corpus: {len(docs)} files, {corpus_bytes} bytes utf-8, from {vault}")

    entries = [(q, m, c, n) for q, m, c, n in QUERIES]
    queries_out = []
    for q, mode, cat, note in entries:
        gt = ground_truth(docs, q, mode)
        queries_out.append({"query": q, "mode": mode, "category": cat,
                            "note": note, "gt_count": len(gt), "gt": gt,
                            "canonical": choose_canonical(gt, q, docs, mode)})

    results = {
        "meta": {
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "python": sys.version.split()[0],
            "sqlite_python": sqlite3.sqlite_version,
            "sqlite_cli": None,
            "vault": str(vault),
            "corpus_files": len(docs),
            "corpus_bytes": corpus_bytes,
            "k": K,
            "ground_truth": {
                "substr": "case-insensitive substring over the whole file text",
                "all": "every whitespace-separated token must appear in the file",
            },
            "poc": "file-level index (one row per .md file) for A-F and E; G is a supplementary "
                    "paragraph-level variant of F",
        },
        "schemes": {},
        "queries": queries_out,
        "micro_checks": micro_checks(),
    }
    if SQLITE_CLI.exists():
        try:
            v = subprocess.run([str(SQLITE_CLI), "-version"], capture_output=True, text=True)
            results["meta"]["sqlite_cli"] = v.stdout.strip().split()[0]
        except Exception:
            pass

    db_paths = []
    for scheme in SCHEMES:
        db_path = idx_dir / f"{scheme.key}.db"
        db_paths.append(db_path)
        fts_prefixes = tuple(scheme.tables)
        print(f"\n=== {scheme.label} ===")
        build = build_scheme(scheme, docs, db_path)
        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        stats = dbstat(db_path, fts_prefixes)
        agg, per_query = evaluate(conn, scheme.search, docs, entries)
        timing, failures = median_query_time(conn, scheme.search, [q for q, _, _, _ in entries])
        expr_fn = expr_bigram_prefix if scheme.key in ("F", "G", "H") else (
            expr_bigram if scheme.key in ("C", "C1", "D") else expr_raw)
        probe = bm25_probe(conn, scheme.tables[0], expr_fn)
        conn.close()
        ratio = round(stats["total"] / corpus_bytes, 2) if corpus_bytes else None
        content_bytes = sum(v for n, v in (stats["tables"] or {}).items()
                            if n.endswith("_content"))
        index_only = (stats["total"] - content_bytes - (stats["tables"] or {}).get("sqlite_schema", 0)
                      if stats["available"] else None)
        rec = {
            "label": scheme.label,
            "ddl": scheme.ddl,
            "index_notes": scheme.notes,
            "query_sql": scheme.query_sql,
            "index": {
                "db_bytes": stats["total"],
                "db_bytes_on_disk": build["db_bytes"],
                "fts_bytes": stats["fts"],
                "fts_share": round(stats["fts"] / stats["total"], 3) if stats["fts"] else None,
                "content_bytes": content_bytes if stats["available"] else None,
                "content_bloat": round(content_bytes / corpus_bytes, 2) if content_bytes else None,
                "index_only_bytes": index_only,
                "index_only_bloat": round(index_only / corpus_bytes, 2) if index_only else None,
                "dbstat_available": stats["available"],
                "dbstat_tables": stats["tables"],
                "bloat_vs_corpus": ratio,
            },
            "timing": {
                "build_ms": build["build_ms"],
                "transform_ms": build["transform_ms"],
                "insert_ms": build["insert_ms"],
                "query": timing,
                "query_failures": failures,
            },
            "bm25": probe,
            "metrics": agg,
            "per_category": per_category(per_query),
            "per_query": per_query,
            "db_file": db_path.name,
        }
        results["schemes"][scheme.key] = rec
        if scheme.key == "B2":
            rec["interpretation"] = (
                "B2 reproduces the substring ground truth by construction (LIKE over the content "
                "column); its 100% hit rate is tautological. Read its cost, not its accuracy.")
        if scheme.key == "E":
            rec["interpretation"] = (
                "E is dominated by F: same CJK weakness as B (trigram <3 chars), +2x size, slower.")
        print(json.dumps(rec["metrics"], ensure_ascii=False, indent=2)[:900])
        print(f"  index: {rec['index']['db_bytes']} B  (bloat x{ratio})  "
              f"build {build['build_ms']} ms  query {timing['median_ms'] if timing else None} ms")

    # ---- write schema files ----
    for scheme in SCHEMES:
        rec = results["schemes"][scheme.key]
        lines = [f"-- scheme {scheme.key}: {scheme.label}",
                 f"-- notes: {scheme.notes}",
                 "--", "-- DDL"]
        lines += [s + ";" for s in scheme.ddl]
        lines += ["", "-- representative search", scheme.query_sql, "",
                  "-- index size: %s B (x%s corpus)" % (rec["index"]["db_bytes"],
                                                        rec["index"]["bloat_vs_corpus"]),
                  "-- build: %s ms (transform %s ms / insert %s ms)" % (
                      rec["timing"]["build_ms"], rec["timing"]["transform_ms"],
                      rec["timing"]["insert_ms"])]
        if scheme.transform is not None:
            lines += ["", "-- write-time transform lives in bench.py:",
                      "--   " + scheme.transform.__name__]
        (out / f"{scheme.key}_schema.sql").write_text("\n".join(lines) + "\n", encoding="utf-8")

    # ---- db retention policy ----
    total_db = sum(p.stat().st_size for p in db_paths if p.exists())
    results["meta"]["db_total_bytes"] = total_db
    keep = args.keep_db or total_db <= args.max_db_mb * 1024 * 1024
    results["meta"]["db_retained"] = keep
    if not keep:
        for p in db_paths:
            if p.exists():
                p.unlink()
        results["meta"]["db_retention_note"] = (
            f"indexes totalled {total_db} B > {args.max_db_mb} MB, deleted; "
            "rerun `py -3 bench.py` to regenerate")
    print(f"\nindexes total {total_db} B; {'kept' if keep else 'deleted'}")

    (out / "results.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {out / 'results.json'}")

    # compact console summary
    print("\n%-34s %6s %6s %7s %7s %7s %8s %8s" % (
        "scheme", "hit@1", "hit@5", "canon@1", "canon@3", "P@5", "idx_bloat", "q_med"))
    for key, rec in results["schemes"].items():
        m = rec["metrics"]
        print("%-34s %6s %6s %7s %7s %7s %8s %8s" % (
            key, m["hit@1"], m["hit@5"], m["canonical@1"], m["canonical@3"],
            m["precision@5"], rec["index"]["index_only_bloat"],
            (rec["timing"]["query"] or {}).get("median_ms")))
    bad = [c for c in results["micro_checks"] if not c["pass"]]
    print(f"\nmicro checks: {len(results['micro_checks']) - len(bad)}/{len(results['micro_checks'])} as expected")
    for c in bad:
        print("  MISMATCH", c["id"], c["what"], "expected", c["expected_rows"], "got", c["got_rows"], c["error"])


if __name__ == "__main__":
    main()
