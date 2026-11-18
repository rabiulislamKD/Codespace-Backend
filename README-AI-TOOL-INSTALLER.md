# AI Tool Installer (CodeSpace 3.13.13)

When a task requires a missing tool, the agent should detect it, research the official source, and call `install_tool`. The tool receives the reason, source, exact install command, optional workspace-relative folder, shell, and a verification command.

## User experience
1. The agent checks whether the tool already exists.
2. It researches the official project documentation, GitHub repository/release, or package registry.
3. It presents the source and exact installation command in an approval dialog.
4. After approval, the command runs through CodeSpace's existing `/run` terminal permission gate.
5. If supplied, the verification command has a second independent approval. The agent continues the original task only after verifying success.

## Supported source types
The agent may choose the appropriate package manager or official source for the environment: npm/pnpm/yarn, pip/uv, Cargo, Go, .NET, GitHub clone/release assets, and other locally available package managers. This is command-driven rather than hard-coded to one registry.

## Safety
- No silent installs; the exact command is shown for approval.
- Uses existing terminal permission settings and checkpoint behavior.
- Dedicated installer blocks common `curl | sh`, `wget | bash`, PowerShell download-to-`iex`, `sudo`/`runas`, and execution-policy bypass patterns.
- Prefer project-local installs. Never run unreviewed remote scripts or disable security controls.
- Admin-only installers must be handled manually by the user.

Note: `run_command` remains available for normal development commands. `install_tool` is a purpose-built, more transparent path for dependency/tool installation.
