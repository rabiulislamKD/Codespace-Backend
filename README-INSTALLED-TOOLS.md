# Installed Tools Manager

CodeSpace records tools installed through the AI `install_tool` action in `~/.my-agent/installed-tools.json` (or the configured `MY_AGENT_DATA_DIR`). The manager shows the tool name, version, update state and installation history.

The AI should provide `uninstall_command`, `update_check_command` and `update_command` when the source/package manager supports them. Missing commands are not guessed. Update checks, updates and uninstalls use the existing terminal approval flow and server-side terminal permission gate.

Only installations made through the updated AI installer are automatically tracked. Tools installed manually or before this version are not discovered automatically.

The Extensions page accepts CodeSpace extension repositories containing `extension.json`. VS Code Marketplace `.vsix` packages are no longer shown because they cannot execute in CodeSpace's extension host.
