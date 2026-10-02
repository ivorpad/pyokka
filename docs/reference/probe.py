import sys, time
# Probe: can a sys.monitoring LINE callback see the executing frame and its locals?
tool = 3
sys.monitoring.use_tool_id(tool, "probe")
seen = []
def on_line(code, line):
    if code.co_filename != "<user>":
        return sys.monitoring.DISABLE
    f = sys._getframe(1)
    seen.append((line, f.f_code.co_name, dict(f.f_locals)))
sys.monitoring.register_callback(tool, sys.monitoring.events.LINE, on_line)
src = "def f(n):\n    a = n * 2\n    b = a + 1\n    return b\nr = f(3)\n"
co = compile(src, "<user>", "exec")
sys.monitoring.set_events(tool, sys.monitoring.events.LINE)
g = {}
exec(co, g)
sys.monitoring.set_events(tool, 0)
for s in seen: print(s)
# Overhead check: 1e6 lines with settrace-free monitoring but capturing locals dict
src2 = "def g():\n    t = 0\n    for i in range(300000):\n        t += i\n    return t\ng()\n"
co2 = compile(src2, "<user>", "exec")
t0=time.perf_counter(); exec(co2, {}); t1=time.perf_counter()
seen.clear()
sys.monitoring.set_events(tool, sys.monitoring.events.LINE)
t2=time.perf_counter(); exec(co2, {}); t3=time.perf_counter()
sys.monitoring.set_events(tool, 0)
print("plain %.3fs  monitored+locals %.3fs  steps=%d" % (t1-t0, t3-t2, len(seen)))
