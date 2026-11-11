import os
import subprocess
import sys

# 注意：不能用 CommandLine like '*lagfix*monitor*'——查询进程自身的命令行也含这些词，
# 会匹配到自己（PID 每次变就是这个坑）。改为 Name 过滤 + 精确脚本名，并排除自身。
ps = (
    "Get-CimInstance Win32_Process -Filter \"Name like '%python%'\" | "
    "Where-Object { $_.CommandLine -like '*install_monitor.py*' -and "
    "$_.CommandLine -like '*zcode-lagfix*' } | "
    "ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }"
)
out = subprocess.run(
    ["powershell", "-NoProfile", "-Command", ps],
    capture_output=True, text=True, encoding="utf-8", errors="replace",
)
print("stdout:", repr(out.stdout))
print("stderr:", repr(out.stderr[:300]))

me = os.getpid()
found = []
for line in out.stdout.splitlines():
    line = line.strip()
    if not line or "|" not in line:
        continue
    pid, cmd = line.split("|", 1)
    pid = pid.strip()
    if not pid.isdigit() or int(pid) == me:
        continue
    found.append((pid, cmd.strip()))

print("lagfix monitor:", found)
for pid, cmd in found:
    r = subprocess.run(["taskkill", "/PID", pid, "/F"], capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    print("kill", pid, "rc=", r.returncode, (r.stdout or r.stderr or "").strip()[:120])
sys.exit(0)
