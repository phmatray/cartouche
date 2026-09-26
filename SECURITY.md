# Security policy

## Supported versions

Only the latest release and the version deployed at
https://phmatray.github.io/cartouche/ receive fixes.

## Reporting a vulnerability

Please do **not** open a public issue for a security problem. Report it
privately through GitHub:
[Report a vulnerability](https://github.com/phmatray/cartouche/security/advisories/new)
(repository **Security** tab > **Advisories** > **Report a vulnerability**).

Include what you found, how to reproduce it, and the impact you expect. You
should get a first answer within 7 days. Once a fix is released, the advisory
is published with credit to you unless you prefer otherwise.

## Scope

Cartouche runs entirely in the browser and has no server. Relevant issues
include, for example: a crafted ROM or save state that escapes the
WebAssembly sandbox's expected behavior (crash loops, memory exhaustion,
script injection into the page), cross-site scripting in the UI, or a
dependency with a known vulnerability that is reachable from the app.
