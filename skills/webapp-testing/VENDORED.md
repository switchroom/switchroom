# Vendored from anthropics/skills

Source: https://github.com/anthropics/skills/tree/main/skills/webapp-testing
License: MIT (see LICENSE.txt in this directory)
Pinned to commit: 5128e1865d670f5d6c9cef000e6dfc4e951fb5b9

## Why vendored

Switchroom ships this skill as a built-in default so every agent gets it
on scaffold (and on `switchroom update` for pre-existing agents).
Vendoring keeps the skill content available offline and version-pinned.

Opt out with:

```yaml
defaults:
  bundled_skills:
    webapp-testing: false
```

## Resyncing

To pull a newer upstream:

```bash
PIN=<new-sha>
rm -rf skills/webapp-testing
git clone --depth 1 https://github.com/anthropics/skills /tmp/anthropic-skills-vendor
(cd /tmp/anthropic-skills-vendor && git fetch --depth 1 origin $PIN && git checkout $PIN)
cp -r /tmp/anthropic-skills-vendor/skills/webapp-testing skills/webapp-testing
# update the Pinned line above
```
