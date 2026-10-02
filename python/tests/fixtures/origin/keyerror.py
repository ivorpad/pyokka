"""KeyError: a settings line has a typo in its key, so the dict reaches address() without "port"."""


def load_settings(lines):
    settings = {}
    for line in lines:
        key, value = line.split("=")
        settings[key.strip()] = value.strip()
    return settings


def address(settings):
    return settings["host"] + ":" + settings["port"]


def main():
    settings = load_settings(["host = db.local", "prot = 5432"])
    print(address(settings))


main()
