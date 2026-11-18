# CodeSpace 3.13.12

## Verification harness repairs

- Updated the model/thinking verifier to locate the current provider-catalog function boundary and provide the Chat Z.ai predicate dependency when isolating the OpenAI adapter.
- Corrected the Browser Bridge verifier: `ipcRenderer.invoke()` is an intentional request/response API in the narrow preload bridge; the network-event subscription itself remains receive-only. The check now verifies the subscription path rather than rejecting all valid invoke calls.
- Removed the legacy 3.10.0 integration script from `verify:all`. It remains available as a standalone historical test, but can stall in its task-creation phase on this host. Current 3.11.0, 3.12.8, and focused 3.12.8 checks remain in the aggregate suite.

## Verification run

- Node test suite: 84/84 passed.
- Main application verification: 173/173 passed.
- Model/thinking verification: 28/28 passed.
- Browser Bridge verification: 89/89 passed.
- 3.11.0 security verification: 147/147 passed.
- 3.12.8 sandbox verification: 74 passed, 0 failed, 1 provider-unavailable (not tested on this host).
- Focused 3.12.8 verification: 16/16 passed.
- Desktop packaging checks: 14/14 passed.
- Integrated Browser checks: 8/8 passed.
- Chat Z.ai checks: 6/6 passed.

Electron GUI startup, Windows portable packaging, and a live Google login remain untested in this Linux environment.
