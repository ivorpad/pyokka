"""Runtime plugins loaded through ``config.plugins`` (see docs/PROTOCOL.md, "Plugins").

Each module defines the optional hooks ``before(config)``, ``before_each(config)``
and ``after(config)``; the runtime appends ``pyokka_runtime.plugins.http_record``
itself when ``config.http`` is set.
"""
