config = {"name": "job", "opts": {"retries": 3, "hosts": ["a", "b"]}}
items = [{"id": 1}, {"id": 2}]
deep = {"a": {"b": {"c": {"d": {"e": {"f": {"g": "bottom"}}}}}}}
count = len(items)
print(config["opts"]["retries"], count)
