import sys


def main(argv):
    got = argv[1:]
    print("argv:", got)
    return got


main(sys.argv)
