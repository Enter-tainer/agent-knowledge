/**
 * jsdom 测试环境初始化：在每个测试文件加载前安装滚动 / matchMedia 补丁。
 * 具体用例可 import `./helpers/env` 的 setScrollY / scrollTo 等辅助函数。
 */
import { afterEach } from 'vitest';

import { installTestEnv, setScrollY } from './helpers/env';

installTestEnv();

afterEach(() => {
  setScrollY(0);
});
