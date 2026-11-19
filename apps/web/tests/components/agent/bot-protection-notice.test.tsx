import { BrowserTabId } from "@contingency/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";

import { BotProtectionNotice } from "@/components/agent/bot-protection-notice";

afterEach(cleanup);

test("names the blocking site and dismisses on request", async () => {
  const user = userEvent.setup();
  const onDismiss = vi.fn<() => void>();
  render(
    <BotProtectionNotice
      block={{
        provider: "cloudflare",
        status: 403,
        tabId: BrowserTabId.make("tab-1"),
        timestamp: 0,
        type: "bot_protection_block",
        url: "https://auth.shop.example/login",
      }}
      onDismiss={onDismiss}
    />
  );
  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent("auth.shop.example blocked this browser");
  expect(alert).toHaveTextContent(
    "Cloudflare bot protection refused a request with HTTP 403."
  );
  await user.click(
    screen.getByRole("button", { name: "Dismiss bot protection notice" })
  );
  expect(onDismiss).toHaveBeenCalledOnce();
});
