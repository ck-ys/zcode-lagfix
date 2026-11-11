#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验证 lagfix 与 zusage 的注入行正则互不误伤（共存协议 R1）。

v2：lagfix 注入行改为「\n 前缀」协议（防入口尾行是 // 注释时被吞），
正则要求匹配连同前导 \n 一起匹配，剥离后字节级可还原。
"""

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "plugins" / "zcode-lagfix"))
import patch_install as pi  # noqa: E402

# zusage 真实注入行样例（本机 asar 实读，2026-11-09 审计取证）
ZUSAGE_LINE = (
    b';import("file:///C:/Users/86182/.zcode/zcode-token-usage-statusbar/inject-main.cjs")'
    b'.then(() => null, (e) => console.error("[zusage] load failed", e));'
)
# zusage 的 ZUSAGE_LINE_RE 等价特征（文件名 + 报错标记，任意目录）
ZUSAGE_LINE_RE = re.compile(
    rb';import\("file://[^"]*/inject-main\.cjs"\)'
    rb'\.then\(\(\) => null, \(e\) => console\.error\("\[zusage\] load failed", e\)\);'
)

OUR_LINE = pi.inject_line(Path("C:/Users/86182/.zcode/zcode-lagfix"))
OUR_LINE_OLD_DIR = pi.inject_line(Path("D:/somewhere/old-runtime"))


def main() -> int:
    ok = True

    def check(name: str, cond: bool):
        nonlocal ok
        print(f"  [{'PASS' if cond else 'FAIL'}] {name}")
        ok = ok and cond

    print("== line_regex 测试 ==")
    # 1. 我们的 RE：连同前导 \n 匹配自己的行（任意目录），不匹配 zusage 的行
    check("我们的 RE 匹配我们的行(含前导\\n)",
          pi.LAGFIX_LINE_RE.search(b"\n" + OUR_LINE) is not None)
    check("我们的 RE 匹配旧目录的行", pi.LAGFIX_LINE_RE.search(b"\n" + OUR_LINE_OLD_DIR) is not None)
    check("无前导 \\n 时不算一条已注入行(防误判)", pi.LAGFIX_LINE_RE.search(OUR_LINE) is None)
    check("我们的 RE 不匹配 zusage 行", pi.LAGFIX_LINE_RE.search(ZUSAGE_LINE) is None)

    # 2. zusage 的 RE：匹配它自己的行，不匹配我们的行
    check("zusage RE 匹配 zusage 行", ZUSAGE_LINE_RE.fullmatch(ZUSAGE_LINE) is not None)
    check("zusage RE 不匹配我们的行", ZUSAGE_LINE_RE.search(OUR_LINE) is None)

    # 3. 剥离测试：混合入口里只剥自己的（连同它带来的 \n）
    entry = b'console.log("host");\n' + ZUSAGE_LINE + b"\n" + OUR_LINE + b"\n"
    stripped = pi.LAGFIX_LINE_RE.sub(b"", entry)
    check("剥离后 zusage 行保留", ZUSAGE_LINE in stripped)
    check("剥离后我们的行消失", pi.LAGFIX_MARK not in stripped)

    # 4. 往返字节级还原：install 写入形式 stripped + \n + line，RE 剥离后 == stripped
    base = b'// entry tail without newline';  # 模拟入口尾行无换行的最坏情况
    installed = base + b"\n" + OUR_LINE
    check("安装形式恰好 1 条注入行", pi.line_count(installed) == 1)
    check("剥离后字节级还原最坏情况", pi.LAGFIX_LINE_RE.sub(b"", installed) == base)

    # 5. 标记互斥：两行的标识字符串互不包含
    check("标记字符串互不包含",
          b"lagfix-main.cjs" not in ZUSAGE_LINE and b"inject-main.cjs" not in OUR_LINE)

    print("== line_regex 结果：", "PASS" if ok else "FAIL", "==")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
