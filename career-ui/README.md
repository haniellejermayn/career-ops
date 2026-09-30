# Personal Career-Ops UI

A local, dependency-light interface over the existing Career-Ops Markdown files and canonical scripts. It is intended for this personal fork and does not replace `data/applications.md`, `data/pipeline.md`, reports, or resume output directories.

## Start

From the Career-Ops repository root:

```powershell
npm run career-ui
```

The interface opens at `http://127.0.0.1:4310`. Press `Ctrl+C` in the terminal to stop it.

If the browser should not open automatically:

```powershell
npm run career-ui -- --no-open
```

No separate database, Go installation, account, or external service is required. The server listens on the local loopback interface by default and makes no external network calls.

## What it does

- Shows pending scanner jobs and tracked applications in one table. Pending pipeline rows are promoted to `data/applications.md` when edited or advanced.
- Supports add, edit, delete, search, filtering, clickable job links, and inline status updates. Company, role, and URL are individually optional, but at least one identifies the row.
- Preserves deadline, compensation, submission date, notes, and resume links without changing the standard tracker table columns.
- Discovers baseline PDFs dynamically under `local/resume-baselines/`; no list or configuration file needs maintenance.
- Copies a selected baseline and its editable sidecars into one job-specific draft directory under `output/`; later draft revisions reuse that directory without changing status.
- On confirmed submission, saves the exact submitted PDF and editable source in a timestamped snapshot inside that application's `submissions/` directory.
- Can link an existing generated PDF or open PowerShell with a row-specific Career-Ops prompt so the agent decides between reuse, reuse with edits, and regeneration.
- Deletes tracker rows only. Reports and resume artifacts are deliberately preserved.

The How to use screen inside the interface explains the normal Career-Ops workflow and which tasks still benefit from an agent.
