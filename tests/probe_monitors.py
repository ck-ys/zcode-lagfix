import subprocess
import sys

ps = (
    'Get-CimInstance Win32_Process -Filter "Name like \'%python%\'" | '
    'ForEach-Object { "$($_.ProcessId)|$($_.Name)|$($_.CommandLine)" }'
)
out = subprocess.run(
    ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
    capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
)
print("rc=", out.returncode, "err=", (out.stderr or "").strip()[:150])
lag = zus = 0
for ln in out.stdout.splitlines():
    s = ln.strip()
    if "install_monitor" not in s:
        continue
    if "zcode-lagfix" in s:
        lag += 1
        print("LAGFIX:", s.split("|")[0], s.split("|")[1])
    elif "zusage" in s:
        zus += 1
        print("ZUSAGE:", s.split("|")[0], s.split("|")[1])
print("COUNT lagfix=", lag, " zusage=", zus)
