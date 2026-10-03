import { selectableUserAgentProfiles } from "@contingency/protocol";
import type { UserAgentProfileId } from "@contingency/protocol";
import { CheckIcon } from "lucide-react";
import { useRef } from "react";
import type { KeyboardEvent } from "react";

import { cn } from "@/lib/utils";

/**
 * Only the identities Chromium can genuinely reproduce are offered for new
 * work: Safari and Firefox profiles could disguise Chromium with a string but
 * never behave as those engines ([ADR
 * 0013](../../../../../docs/adr/0013-emulation-belongs-to-the-flow.md)).
 */
type UserAgentProfile = (typeof selectableUserAgentProfiles)[number];

const userAgentGroups: {
  readonly group: string;
  readonly profiles: UserAgentProfile[];
}[] = [];

for (const profile of selectableUserAgentProfiles) {
  const existingGroup = userAgentGroups.find(
    ({ group }) => group === profile.group
  );
  if (existingGroup === undefined) {
    userAgentGroups.push({ group: profile.group, profiles: [profile] });
  } else {
    existingGroup.profiles.push(profile);
  }
}

const OPTION_SELECTOR = '[role="option"]';

/** Which option an arrow, Home, or End key moves focus to, if any. */
const focusTarget = (
  key: string,
  current: number,
  last: number
): number | null => {
  if (key === "ArrowDown") {
    return current + 1;
  }
  if (key === "ArrowUp") {
    return current - 1;
  }
  if (key === "Home") {
    return 0;
  }
  if (key === "End") {
    return last;
  }
  return null;
};

/**
 * Every identity the browser can present, grouped by family, as one listbox.
 * Arrows move focus without applying anything — each choice restarts the
 * session's identity, so it is applied only on Enter, Space, or a click.
 */
export const UserAgentList = ({
  disabled,
  onValueChange,
  value,
}: {
  readonly disabled: boolean;
  readonly onValueChange: (value: UserAgentProfileId) => void;
  readonly value: UserAgentProfileId;
}) => {
  const listRef = useRef<HTMLDivElement>(null);
  const choose = (profile: UserAgentProfile) => {
    if (profile.id !== value) {
      onValueChange(profile.id);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = listRef.current;
    if (list === null) {
      return;
    }
    const options = [...list.querySelectorAll<HTMLElement>(OPTION_SELECTOR)];
    const active = globalThis.document.activeElement;
    const current =
      active instanceof HTMLElement ? options.indexOf(active) : -1;
    const target = focusTarget(event.key, current, options.length - 1);
    if (target === null) {
      return;
    }
    event.preventDefault();
    options[Math.min(Math.max(target, 0), options.length - 1)]?.focus();
  };
  return (
    <div
      aria-disabled={disabled}
      aria-label="User agent"
      className="space-y-2"
      onKeyDown={onKeyDown}
      ref={listRef}
      role="listbox"
    >
      {userAgentGroups.map(({ group, profiles }) => (
        <div aria-label={group} key={group} role="group">
          <div
            aria-hidden="true"
            className="text-muted-foreground px-2 py-1 text-xs font-medium"
          >
            {group}
          </div>
          {profiles.map((profile) => {
            const selected = profile.id === value;
            return (
              <div
                aria-disabled={disabled}
                aria-selected={selected}
                className={cn(
                  "hover:bg-muted focus-visible:ring-ring/50 flex w-full cursor-default items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors outline-none focus-visible:ring-2 aria-disabled:pointer-events-none aria-disabled:opacity-50",
                  selected && "bg-muted font-medium"
                )}
                key={profile.id}
                onClick={() => {
                  if (!disabled) {
                    choose(profile);
                  }
                }}
                onKeyDown={(event) => {
                  if (
                    !disabled &&
                    (event.key === "Enter" || event.key === " ")
                  ) {
                    event.preventDefault();
                    choose(profile);
                  }
                }}
                role="option"
                tabIndex={selected ? 0 : -1}
              >
                {profile.label}
                {selected ? (
                  <CheckIcon aria-hidden="true" className="size-3.5 shrink-0" />
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
};
