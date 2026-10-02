"""A stand-in for a third-party package (outside the workspace) used by the e2e suite."""


def twice(x):
    doubled = x * 2
    return doubled


def describe(x):
    return f"twice {x} is {twice(x)}"
