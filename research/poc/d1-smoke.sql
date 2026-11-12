DELETE FROM documents; DELETE FROM doc_fts; DELETE FROM doc_tri;
INSERT INTO documents(id,path,title,body) VALUES
 (1,'a.md','电机校准','电机校准与压感等级：HALL 传感器，寄存器 0x7000，调用 ABS_PRESSURE_CTRL'),
 (2,'b.md','BLE 协议','BLE 协议的 A5 帧与 CRC-16/MODBUS 校验，getUserById 未使用'),
 (3,'c.md','LSPosed','LSPosed 四 hook 与 persist.enote.app_install 安装闸门');
INSERT INTO doc_fts(rowid,search_text) VALUES
 (1,'电机 机校 校准 压感 感等 等级 hall 传感器 寄存 存器 7000 调用 abs pressure ctrl 电机校准与压感等级'),
 (2,'ble 协议 议 的 a5 帧与 crc modbus 校验 user by id 未使 使用'),
 (3,'lsposed hook persist enote app install 安装 装闸 闸门');
INSERT INTO doc_tri(rowid,body) VALUES (1,(SELECT body FROM documents WHERE id=1)),(2,(SELECT body FROM documents WHERE id=2)),(3,(SELECT body FROM documents WHERE id=3));
SELECT 'fts-2char' AS q, path FROM documents d JOIN doc_fts f ON f.rowid=d.id WHERE doc_fts MATCH '"电机"' ORDER BY bm25(doc_fts) LIMIT 3;
SELECT 'fts-1char-prefix' AS q, path FROM documents d JOIN doc_fts f ON f.rowid=d.id WHERE doc_fts MATCH '压*' LIMIT 3;
SELECT 'fts-mixed' AS q, path FROM documents d JOIN doc_fts f ON f.rowid=d.id WHERE doc_fts MATCH '"ble 协议"' LIMIT 3;
SELECT 'fts-ident-prefix' AS q, path FROM documents d JOIN doc_fts f ON f.rowid=d.id WHERE doc_fts MATCH '0x700*' LIMIT 3;
SELECT 'tri-2char' AS q, count(*) AS n FROM doc_tri WHERE doc_tri MATCH '"电机"';
SELECT 'tri-3char' AS q, count(*) AS n FROM doc_tri WHERE doc_tri MATCH '"电机校"';
SELECT 'tri-ident-sub' AS q, count(*) AS n FROM doc_tri WHERE doc_tri MATCH '"UserBy"';
SELECT 'bm25-order' AS q, path, bm25(doc_fts) AS score FROM documents d JOIN doc_fts f ON f.rowid=d.id WHERE doc_fts MATCH '"安装"' ORDER BY bm25(doc_fts) LIMIT 3;
