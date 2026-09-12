# Ecommerce end-to-end drive

Historical recipe. Its Create and Audit routes were removed in #170. Use [Workspace](./workspace.md) for current UI verification. The deterministic CLI remains until #165 Phase 6.

This historical drive covered deterministic Flow authoring: browse a local ecommerce site in Create View, record a cart Flow in a fresh session, download the Flow JSON, then replay it in Audit View with video scrubbing.

## Sub-features

- `ecommerce-serve` starts the local shop on `127.0.0.1`.
- `create-browse` explores the shop without recording: navigate, click, scroll, hover, type.
- `create-sessions` creates a second session and switches between sessions.
- `create-record` records a Flow in the new session: shop URL, title, SKU add, cart navigation, finish, download JSON.
- `audit-open` loads the downloaded Flow through Audit View's file picker.
- `audit-run` runs the Flow to `Completed` and inspects step timeline and derived frames.
- `audit-video` scrubs the derived frames, plays video, and steps through frame pins.

## How to get to it (user POV)

- Launch the verification instance and run `doctor`.
- Start the ecommerce site with `control-contingency ecommerce start`.
- Open Create View at `/`.
- After recording, open Audit View and use `Open a Flow file` with the downloaded JSON.

## Driving it with control-contingency

Preconditions:

- `control-contingency doctor` reports `ok: true`.
- `control-contingency ecommerce start` printed `ecommerce=http://127.0.0.1:<port>/shop.html`.
- Export `ECOMMERCE_URL` from that line for nested browsing.
- Chromium is installed for Playwright (`nub exec --cwd packages/cli playwright-core install chromium`).

### 1. Start ecommerce

Run `control-contingency ecommerce start`. Stdout contains `ecommerce=`, `fixture=` (same URL), and `flow=` (smoke navigate Flow for headless checks).

### 2. Create View — browse without recording (session A)

Use `computerUse` at the verification URL for nested site actions.

- **Open Create View.** `control-contingency browser goto --path /`.
- **Create session A.** Open `Choose browser session`, create `browse-a` (or equivalent). Combobox becomes `Browser session: browse-a`.
- **Open shop.** Fill `Browser address` with `$ECOMMERCE_URL` and press Enter on that textbox.
- **Browse the shop (nested).** With `computerUse`: open `Catalog`, scroll the product list, hover a product, type in `Search the catalogue`, click `Home`, return to shop home. Do not start Recording yet.
- **Proof (browse).** `control-contingency browser snapshot --aria --path ecommerce-drive/create-browse.aria.txt` and screenshot `ecommerce-drive/create-browse.png`.

### 3. Create View — session switching

Still without Recording:

- **Create session B.** Open the session combobox, create `record-b`.
- **Switch to session A.** Select `browse-a` from the combobox. The address bar should reflect session A's last URL.
- **Switch to session B.** Select `record-b`. Workspace shows the new session (empty or default state).
- **Proof (sessions).** Snapshot shows `Browser session: record-b` after the final switch. Paths: `ecommerce-drive/create-sessions.aria.txt`, `create-sessions.png`.

### 4. Create View — record cart Flow (session B)

Nested actions use `computerUse`. Chrome actions use `control-contingency browser`.

- **Open shop in session B.** Fill `Browser address` with `$ECOMMERCE_URL`, press Enter.
- **Set Flow title.** Fill `Flow title` with `Contingency Shop checkout`.
- **Start Recording.** Click `Start Recording`. Status becomes `active`; Steps badge reaches at least `1 Steps`.
- **Add SKU (nested).** Type `ANVIL-001` into the `SKU` field and click `Add SKU to cart`.
- **Open cart (nested).** Click `View cart`. Cart heading `Cart` is visible and lists `SKU ANVIL-001`.
- **Finish Recording.** `control-contingency browser click --role button --name Finish`. Phase becomes `finished`; a `Download …json` button appears.
- **Download Flow JSON.** `control-contingency browser download --role button --name ".json" --partial --path "$CONTINGENCY_VERIFY_DIR/recorded-flow.json"`. Copy the saved file to `ecommerce-drive/recorded-flow.json` under artifacts.
- **Proof (record).** Snapshot + screenshot after Finish showing download button and multiple Steps. Paths: `ecommerce-drive/create-record.aria.txt`, `create-record.png`.

### 5. Audit View — open Flow and run

- **Open Audit empty.** `control-contingency browser goto --path /audit`. Heading `No Flow to audit`.
- **Load recorded Flow.** `control-contingency browser set-input-files --label "Open a Flow file" --path "$CONTINGENCY_VERIFY_DIR/recorded-flow.json"`. Heading becomes `Contingency Shop checkout`; `Run Flow` is enabled.
- **Run Flow.** Click `Run Flow`. Wait for `Run again` with status `Completed` (timeout 120000 ms). Read `run.json` under `$CONTINGENCY_VERIFY_DIR/state/runs/**/`; `outcome` is `completed`.
- **Proof (run).** `ecommerce-drive/audit-run.aria.txt`, `audit-run.png`.

### 6. Audit View — step timeline and video

After the Run completes:

- **Select a Step.** Click a Step in the timeline list (for example the cart navigation Step).
- **Scrub derived frames.** Use the `Scrub the derived frames` slider or click a frame pin (`Step 0`, `Run settled`, etc.).
- **Play video.** Click `Play`, wait briefly, click `Pause`.
- **Step pins.** Click `Next Step` / `Previous Step` when enabled.
- **Proof (video).** Screenshot while a non-zero frame is selected. Paths: `ecommerce-drive/audit-video.aria.txt`, `audit-video.png`.

## Gotchas

- Nested ecommerce interactions are not available through `control-contingency browser` canvas clicks. Use `computerUse` for browse/click/scroll/hover/type inside the workspace.
- Session switching clears picker edit buffers; URLs travel through the address bar and session state, not the Flow title field.
- `Finish` is disabled until at least one Step exists beyond the opening navigation.
- Download button text includes the normalized Flow filename (for example `127-0-0-1-<port>-contingency-shop-checkout.json`). Use `--partial` on `browser download`.
- `set-input-files` targets the labeled `Open a Flow file` control on the empty Audit View. After a Flow is loaded, the header button is `Open a Flow` and replaces the current Flow.
- Cart replay depends on `sessionStorage` in the nested browser. The recorded Steps must include the SKU and cart navigation, not assumed cart state.
- Do not extend this recipe into Agent View unless explicitly asked.
