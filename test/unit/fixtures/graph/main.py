"""Fixture for the execution graph's statement nodes: a script-shaped program.

Exercises what the reads/targets scanner must handle: keyword arguments, f-strings, attribute
reads, tuple targets, an augmented assignment in a loop, a loop target read by the body, a
parameter read by a statement of the function, an if/else, a handled raise, prints, a
multi-line call, a docstring statement and an import (both never become nodes).
"""
import os


class Event:
    def __init__(self, name, date, participants):
        self.name = name
        self.date = date
        self.participants = participants


def parse_event(text, year=2026):
    """Split 'name|date|a,b' into an Event."""
    name, date, people = text.split("|")
    participants = people.split(",")
    event = Event(
        name=name,
        date=f"{date} {year}",
        participants=participants,
    )
    return event


def shout(word):
    if not word:
        raise ValueError("empty")
    return word.upper()


text = "fair|Sep 16|alice,bob"  # the '|' separates the fields
event = parse_event(text, year=2026)
count = 0
for person in event.participants:
    count += 1
    print(f"Participant: {person}")
label = shout(event.name)
if count > 1:
    summary = f"{label} with {count} people on {event.date}"
else:
    summary = label
print(summary)
try:
    shout("")
except ValueError:
    handled = True
