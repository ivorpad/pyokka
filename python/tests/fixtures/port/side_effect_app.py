# Appends a line to a log on every start, so a second execution is visible from outside.
import os

with open(os.environ.get("PK_SIDE_EFFECT_LOG", "/tmp/pk-side-effect.log"), "a") as log:
    log.write("started\n")
total = 0
for i in range(3):
    total += i
print("total", total)
