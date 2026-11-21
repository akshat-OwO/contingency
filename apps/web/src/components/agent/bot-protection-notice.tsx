import type { BrowserBotProtectionBlock } from "@contingency/protocol";
import { ShieldAlertIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

const PROVIDER_NAMES: Record<BrowserBotProtectionBlock["provider"], string> = {
  cloudflare: "Cloudflare",
};

/** The host a refused request went to, or the whole URL when it has none. */
const hostOf = (url: string): string => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

/**
 * The site's bot protection refused the session's browser. Without this, a
 * blocked login just resets its form, and the user blames the site or the
 * Flow (#266). Only the latest block shows: one refusal usually brings
 * several requests down with it, and they all say the same thing.
 *
 * It is a toned island rather than a destructive alert (#777): nothing is
 * broken, the site is turning automated browsers away. It stays until
 * dismissed, and only its own box takes pointer input over the stream.
 */
export const BotProtectionNotice = ({
  block,
  onDismiss,
}: {
  readonly block: BrowserBotProtectionBlock;
  readonly onDismiss: () => void;
}) => (
  <div
    className="island bg-island-solid mx-auto flex w-full max-w-[480px] items-start gap-2.5 rounded-2xl py-2.5 pr-2 pl-2.5 text-left"
    role="alert"
  >
    <span className="bg-brand-ink/14 text-brand-ink grid size-6 shrink-0 place-items-center rounded-full">
      <ShieldAlertIcon aria-hidden="true" className="size-3.5" />
    </span>
    <div className="grid min-w-0 flex-1 gap-0.5">
      <p className="text-[13px] font-semibold wrap-anywhere">
        {hostOf(block.url)} blocked this browser
      </p>
      <p className="text-muted-foreground text-[12.5px] text-pretty">
        {PROVIDER_NAMES[block.provider]} bot protection refused a request with
        HTTP {block.status}. The site is turning away automated browsers, so the
        page is not broken and neither is the Flow.
      </p>
    </div>
    <Button
      aria-label="Dismiss bot protection notice"
      className="-mt-0.5 shrink-0"
      onClick={onDismiss}
      size="icon-sm"
      type="button"
      variant="island"
    >
      <XIcon aria-hidden="true" />
    </Button>
  </div>
);
