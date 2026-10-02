"""IndexError: the last row has two fields, so third_field() reads past the end of its list."""


def parse_line(line):
    return line.split(",")


def third_field(fields):
    return fields[2]


ROWS = ["a,b,c", "d,e,f", "g,h"]
for row in ROWS:
    fields = parse_line(row)
    print(third_field(fields))
