import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { flushSync } from "react-dom";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

type ThemeChoice = "dark" | "light" | "system";

const CHOICES: readonly {
  readonly Icon: LucideIcon;
  readonly label: string;
  readonly value: ThemeChoice;
}[] = [
  { Icon: SunIcon, label: "Light", value: "light" },
  { Icon: MoonIcon, label: "Dark", value: "dark" },
  { Icon: MonitorIcon, label: "System", value: "system" },
];

const isThemeChoice = (value: unknown): value is ThemeChoice =>
  value === "dark" || value === "light" || value === "system";

/**
 * Light, Dark and System as radio items (#779). The saved choice is checked,
 * so System stays a choice of its own, and it says which theme it gives now.
 */
const ModeToggle = ({ className }: { readonly className?: string }) => {
  const { setTheme, systemTheme, theme } = useTheme();
  const choice: ThemeChoice = isThemeChoice(theme) ? theme : "system";
  // Light and dark cross-fade rather than flash: the view transition captures
  // the old theme, and the synchronous update applies the new one before the
  // new frame is captured. next-themes still turns other transitions off for
  // the switch, so controls don't animate one by one.
  const changeTheme = (next: ThemeChoice) => {
    if (!("startViewTransition" in document)) {
      setTheme(next);
      return;
    }
    document.startViewTransition(() => {
      flushSync(() => setTheme(next));
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label="Change color theme"
            className={cn("relative", className)}
            size="icon"
            variant="outline"
          />
        }
      >
        <SunIcon className="scale-100 rotate-0 opacity-100 transition-[opacity,transform] motion-reduce:transition-none dark:scale-95 dark:-rotate-90 dark:opacity-0" />
        <MoonIcon className="absolute scale-95 rotate-90 opacity-0 transition-[opacity,transform] motion-reduce:transition-none dark:scale-100 dark:rotate-0 dark:opacity-100" />
      </DropdownMenuTrigger>
      {/* Like the session switcher: clear the island, then a gap of its own. */}
      <DropdownMenuContent align="end" sideOffset={14} variant="island">
        <DropdownMenuRadioGroup
          onValueChange={(value) => {
            if (isThemeChoice(value)) {
              changeTheme(value);
            }
          }}
          value={choice}
        >
          {CHOICES.map(({ Icon, label, value }) => {
            const now =
              value === "system" && systemTheme !== undefined
                ? `${systemTheme === "dark" ? "Dark" : "Light"} now`
                : undefined;
            return (
              <DropdownMenuRadioItem
                // A flex row reads its parts with spaces between them, so
                // System names its hint itself: "System, Light now".
                aria-label={now === undefined ? undefined : `${label}, ${now}`}
                closeOnSelect
                key={value}
                value={value}
              >
                <Icon aria-hidden="true" />
                {label}
                {now === undefined ? null : (
                  <span className="text-muted-foreground/80 ml-auto text-xs font-normal">
                    {now}
                  </span>
                )}
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
};

export { ModeToggle };
