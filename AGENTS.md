# Local Tinycast testing

After validating a change to a plugin, build that plugin and run `pnpm install:local <plugin-name>` to install its `dist/` in the local Tinycast app for the user to test. Check that the installed manifest and command bundles match the build. When a manifest adds or changes an entry, refresh Tinycast’s Extensions catalog so the user can discover it. Keep this workflow scoped to the plugin being changed.
